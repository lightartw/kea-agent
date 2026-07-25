import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";
import {
  type SessionContext,
  type SessionEntry,
  type SessionMessageEntry,
  type SessionModelChangeEntry,
  SessionError,
} from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function newId(): string {
  return randomUUID().slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.type)) return false;

  switch (value.type) {
    case "text":
      return isString(value.text);
    case "thinking":
      return isString(value.thinking) &&
        (value.signature === undefined || isString(value.signature));
    case "toolCall":
      return isString(value.id) && isString(value.name) && isRecord(value.arguments);
    default:
      return false;
  }
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || !isString(value.role)) return false;

  switch (value.role) {
    case "user":
      return isString(value.content);
    case "tool":
      return isString(value.toolCallId) && isString(value.name) &&
        isString(value.content) &&
        (value.isError === undefined || typeof value.isError === "boolean");
    case "assistant": {
      if (!Array.isArray(value.content) || !value.content.every(isContentBlock) ||
        !isString(value.model) || !isString(value.stopReason) ||
        !STOP_REASONS.has(value.stopReason) || !isFiniteNumber(value.latencyMs) ||
        (value.errorMessage !== undefined && !isString(value.errorMessage))) {
        return false;
      }

      if (value.usage === undefined) return true;
      return isRecord(value.usage) && isFiniteNumber(value.usage.inputTokens) &&
        isFiniteNumber(value.usage.outputTokens) && isFiniteNumber(value.usage.totalTokens);
    }
    default:
      return false;
  }
}

function invalidEntry(message: string): never {
  throw new SessionError("invalid_entry", message);
}

function parseEntry(raw: unknown): SessionEntry {
  if (!isRecord(raw) || !isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
    (raw.parentId !== null && (!isString(raw.parentId) || !SESSION_ID_PATTERN.test(raw.parentId))) ||
    !isString(raw.type)) {
    return invalidEntry("Session entry has invalid metadata");
  }

  if (raw.type === "message") {
    if (!isAgentMessage(raw.message)) {
      return invalidEntry("Session message entry has an invalid message");
    }
    return {
      type: "message",
      id: raw.id,
      parentId: raw.parentId,
      message: raw.message,
    };
  }

  if (raw.type === "model_change") {
    if (!isString(raw.provider) || !isString(raw.modelId)) {
      return invalidEntry("Session model change entry has invalid model fields");
    }
    return {
      type: "model_change",
      id: raw.id,
      parentId: raw.parentId,
      provider: raw.provider,
      modelId: raw.modelId,
    };
  }

  return invalidEntry("Session entry has an unknown type");
}

function validateTree(entries: readonly SessionEntry[]): void {
  const byId = new Set<string>();
  let rootCount = 0;

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      invalidEntry("Session contains duplicate entry IDs");
    }
    if (entry.parentId === null) {
      rootCount += 1;
    } else if (!byId.has(entry.parentId)) {
      invalidEntry("Session entry references a missing parent");
    }
    byId.add(entry.id);
  }

  if (rootCount !== 1) {
    invalidEntry("Session entries must form one rooted tree");
  }
}

function sessionPath(storageDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionError("invalid_session", "Session ID is invalid");
  }
  return join(storageDir, "sessions", `${sessionId}.jsonl`);
}

function asStorageError(message: string, error: unknown): SessionError {
  return new SessionError("storage", message, { cause: error });
}

export class Session {
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;
  private flushed = false;

  private constructor(
    readonly id: string,
    private readonly persistPath: string | null,
  ) {}

  static async create(storageDir: string): Promise<Session> {
    try {
      await mkdir(join(storageDir, "sessions"), { recursive: true });
    } catch (error) {
      throw asStorageError("Could not create session storage", error);
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const id = `${timestamp}_${randomUUID().slice(0, 8)}`;
    return new Session(id, sessionPath(storageDir, id));
  }

  static async open(storageDir: string, sessionId: string): Promise<Session> {
    const path = sessionPath(storageDir, sessionId);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionError("not_found", `Session ${sessionId} was not found`, {
          cause: error,
        });
      }
      throw asStorageError("Could not read session storage", error);
    }

    if (contents.trim() === "") {
      throw new SessionError("invalid_session", "Session file is empty");
    }

    const entries: SessionEntry[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        throw new SessionError("invalid_session", "Session file contains invalid JSON", {
          cause: error,
        });
      }
      entries.push(parseEntry(raw));
    }

    validateTree(entries);

    const session = new Session(sessionId, path);
    for (const entry of entries) {
      session.push(entry);
    }
    session.flushed = true;
    return session;
  }

  static inMemory(): Session {
    return new Session(newId(), null);
  }

  private push(entry: SessionEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }

  private rollback(entry: SessionEntry, previousLeafId: string | null): void {
    const popped = this.entries.pop();
    if (popped !== entry) {
      throw new Error("Session append rollback lost the appended entry");
    }
    this.byId.delete(entry.id);
    this.leafId = previousLeafId;
  }

  private async persist(entry: SessionEntry): Promise<void> {
    if (this.persistPath === null) return;

    const hasAssistant = this.entries.some(
      (candidate) => candidate.type === "message" && candidate.message.role === "assistant",
    );
    if (!hasAssistant) return;

    try {
      if (!this.flushed) {
        const allLines = this.entries.map((candidate) => `${JSON.stringify(candidate)}\n`).join("");
        await writeFile(this.persistPath, allLines, { encoding: "utf8", flag: "wx" });
        this.flushed = true;
      } else {
        const file = await open(this.persistPath, "r+");
        try {
          const { size } = await file.stat();
          const contents = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
          let offset = 0;
          while (offset < contents.length) {
            const { bytesWritten } = await file.write(
              contents,
              offset,
              contents.length - offset,
              size + offset,
            );
            if (bytesWritten === 0) {
              throw new Error("Session append wrote zero bytes");
            }
            offset += bytesWritten;
          }
        } finally {
          await file.close();
        }
      }
    } catch (error) {
      throw asStorageError("Could not persist session entry", error);
    }
  }

  private async append(entry: SessionEntry): Promise<void> {
    const validatedEntry = parseEntry(entry);
    const previousLeafId = this.leafId;
    this.push(validatedEntry);
    try {
      await this.persist(validatedEntry);
    } catch (error) {
      this.rollback(validatedEntry, previousLeafId);
      throw error;
    }
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    await this.append({
      type: "message",
      id: newId(),
      parentId: this.leafId,
      message,
    } satisfies SessionMessageEntry);
  }

  async appendModelChange(model: ModelConfig): Promise<void> {
    await this.append({
      type: "model_change",
      id: newId(),
      parentId: this.leafId,
      provider: model.provider,
      modelId: model.model,
    } satisfies SessionModelChangeEntry);
  }

  private branch(): SessionEntry[] {
    const branch: SessionEntry[] = [];
    let cursor = this.leafId;
    while (cursor !== null) {
      const entry = this.byId.get(cursor);
      if (entry === undefined) {
        throw new SessionError("invalid_entry", "Session leaf points to a missing entry");
      }
      branch.push(entry);
      cursor = entry.parentId;
    }
    return branch.reverse();
  }

  buildContext(): SessionContext {
    const messages: AgentMessage[] = [];
    let model: ModelConfig | null = null;

    for (const entry of this.branch()) {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else {
        model = { provider: entry.provider, model: entry.modelId };
      }
    }

    return { messages, model };
  }
}
