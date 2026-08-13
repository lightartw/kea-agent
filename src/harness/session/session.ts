import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";
import {
  type CreateSessionInput,
  type SessionContext,
  type SessionHeader,
  type SessionInfo,
  type SessionMessageEntry,
  type SessionModelChangeEntry,
  type SessionRecord,
  type SessionTitleEntry,
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

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
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
        (value.isError === undefined || typeof value.isError === "boolean") &&
        (value.details === undefined || isJsonValue(value.details));
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

function invalidSession(message: string): never {
  throw new SessionError("invalid_session", message);
}

function validateCwd(directory: string, cwd: string): void {
  if (isAbsolute(cwd)) {
    invalidEntry("Session cwd must be relative");
  }
  const resolved = resolve(directory, cwd);
  const fromDirectory = resolve(directory);
  if (resolved !== fromDirectory && !resolved.startsWith(fromDirectory + sep)) {
    invalidEntry("Session cwd escapes its directory");
  }
}

function parseHeader(raw: unknown): SessionHeader {
  if (!isRecord(raw) || raw.type !== "session" || raw.version !== 1 ||
    !isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
    !isString(raw.projectId) || !isString(raw.directory) ||
    !isString(raw.cwd) || !isString(raw.title) ||
    !isTimestamp(raw.createdAt)) {
    invalidSession("Session header is invalid");
  }
  const directory = resolve(raw.directory);
  validateCwd(directory, raw.cwd);
  return {
    type: "session",
    version: 1,
    id: raw.id,
    projectId: raw.projectId,
    directory,
    cwd: raw.cwd,
    title: raw.title,
    createdAt: raw.createdAt,
  };
}

function parseRecord(raw: unknown): SessionRecord {
  if (!isRecord(raw) || !isString(raw.type) || !isTimestamp(raw.createdAt)) {
    return invalidEntry("Session record has invalid metadata");
  }

  if (raw.type === "message") {
    if (!isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
      (raw.parentId !== null && (!isString(raw.parentId) || !SESSION_ID_PATTERN.test(raw.parentId))) ||
      !isAgentMessage(raw.message)) {
      return invalidEntry("Session message record is invalid");
    }
    return {
      type: "message",
      id: raw.id,
      parentId: raw.parentId as string | null,
      createdAt: raw.createdAt,
      message: raw.message,
    };
  }

  if (raw.type === "model_change") {
    if (!isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
      (raw.parentId !== null && (!isString(raw.parentId) || !SESSION_ID_PATTERN.test(raw.parentId))) ||
      !isString(raw.provider) || !isString(raw.modelId)) {
      return invalidEntry("Session model change record is invalid");
    }
    return {
      type: "model_change",
      id: raw.id,
      parentId: raw.parentId as string | null,
      createdAt: raw.createdAt,
      provider: raw.provider,
      modelId: raw.modelId,
    };
  }

  if (raw.type === "session_title") {
    if (raw.title === undefined || !isString(raw.title)) {
      return invalidEntry("Session title record is invalid");
    }
    return {
      type: "session_title",
      createdAt: raw.createdAt,
      title: raw.title,
    };
  }

  return invalidEntry("Session record has an unknown type");
}

function validateTree(records: readonly SessionRecord[]): void {
  const byId = new Set<string>();
  let rootCount = 0;
  let treeCount = 0;

  for (const record of records) {
    if (record.type === "session_title") continue;
    treeCount += 1;
    if (byId.has(record.id)) {
      invalidEntry("Session contains duplicate entry IDs");
    }
    if (record.parentId === null) {
      rootCount += 1;
    } else if (!byId.has(record.parentId)) {
      invalidEntry("Session entry references a missing parent");
    }
    byId.add(record.id);
  }

  // A fresh Session may contain only a header and no tree records yet.
  if (treeCount > 0 && rootCount !== 1) {
    invalidEntry("Session entries must form one rooted tree");
  }
}

/** Directory where one project's session files live, relative to its storageDir. */
export function sessionsDir(storageDir: string): string {
  return join(storageDir, "sessions");
}

function sessionPath(storageDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionError("invalid_session", "Session ID is invalid");
  }
  return join(sessionsDir(storageDir), `${sessionId}.jsonl`);
}

function asStorageError(message: string, error: unknown): SessionError {
  return new SessionError("storage", message, { cause: error });
}

export class Session {
  private records: SessionRecord[] = [];
  private leafId: string | null = null;
  private pending = Promise.resolve();

  private constructor(
    readonly id: string,
    private readonly persistPath: string | null,
    private readonly header: SessionHeader,
  ) {}

  static async create(storageDir: string, input: CreateSessionInput): Promise<Session> {
    const directory = resolve(input.directory);
    validateCwd(directory, input.cwd);

    const id = newId();
    const header: SessionHeader = {
      type: "session",
      version: 1,
      id,
      projectId: input.projectId,
      directory,
      cwd: input.cwd,
      title: "unknown",
      createdAt: new Date().toISOString(),
    };
    const path = sessionPath(storageDir, id);
    try {
      await mkdir(sessionsDir(storageDir), { recursive: true });
      await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      throw asStorageError("Could not create session storage", error);
    }
    return new Session(id, path, header);
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
      invalidSession("Session file is empty");
    }

    const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
    const header = parseHeader(parseJson(lines[0]!, path));
    if (header.id !== sessionId) {
      invalidSession("Session header ID does not match the filename");
    }

    const records: SessionRecord[] = [];
    for (let index = 1; index < lines.length; index++) {
      records.push(parseRecord(parseJson(lines[index]!, path)));
    }
    validateTree(records);

    const session = new Session(sessionId, path, header);
    for (const record of records) {
      session.push(record);
    }
    return session;
  }

  static inMemory(input: CreateSessionInput): Session {
    const directory = resolve(input.directory);
    validateCwd(directory, input.cwd);
    const header: SessionHeader = {
      type: "session",
      version: 1,
      id: newId(),
      projectId: input.projectId,
      directory,
      cwd: input.cwd,
      title: "unknown",
      createdAt: new Date().toISOString(),
    };
    return new Session(header.id, null, header);
  }

  private push(record: SessionRecord): void {
    this.records.push(record);
    if (record.type !== "session_title") {
      this.leafId = record.id;
    }
  }

  private rollback(record: SessionRecord, previousLeafId: string | null): void {
    const popped = this.records.pop();
    if (popped !== record) {
      throw new Error("Session append rollback lost the appended entry");
    }
    if (record.type !== "session_title") {
      this.leafId = previousLeafId;
    }
  }

  private async persist(record: SessionRecord): Promise<void> {
    if (this.persistPath === null) return;
    try {
      const file = await open(this.persistPath, "r+");
      try {
        const { size } = await file.stat();
        const contents = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
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
    } catch (error) {
      throw asStorageError("Could not persist session entry", error);
    }
  }

  private async append(record: SessionRecord): Promise<void> {
    const validated = parseRecord(record);
    const previousLeafId = this.leafId;
    this.push(validated);
    try {
      await this.persist(validated);
    } catch (error) {
      this.rollback(validated, previousLeafId);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    await this.enqueue(() => this.append({
      type: "message",
      id: newId(),
      parentId: this.leafId,
      createdAt: new Date().toISOString(),
      message,
    } satisfies SessionMessageEntry));
  }

  async appendModelChange(model: ModelConfig): Promise<void> {
    await this.enqueue(() => this.append({
      type: "model_change",
      id: newId(),
      parentId: this.leafId,
      createdAt: new Date().toISOString(),
      provider: model.provider,
      modelId: model.model,
    } satisfies SessionModelChangeEntry));
  }

  private normalizeTitle(title: string): string {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed.includes("\n")) {
      throw new Error("Session title must be a single non-empty line");
    }
    return trimmed;
  }

  async setTitle(title: string): Promise<void> {
    const normalized = this.normalizeTitle(title);
    await this.enqueue(() => this.append({
      type: "session_title",
      createdAt: new Date().toISOString(),
      title: normalized,
    } satisfies SessionTitleEntry));
  }

  async setTitleIfUnknown(title: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.info.title !== "unknown") return false;
      const normalized = this.normalizeTitle(title);
      await this.append({
        type: "session_title",
        createdAt: new Date().toISOString(),
        title: normalized,
      } satisfies SessionTitleEntry);
      return true;
    });
  }

  private branch(): (SessionMessageEntry | SessionModelChangeEntry)[] {
    const branch: (SessionMessageEntry | SessionModelChangeEntry)[] = [];
    let cursor = this.leafId;
    while (cursor !== null) {
      const record = this.records.find((candidate): candidate is SessionMessageEntry | SessionModelChangeEntry =>
        candidate.type !== "session_title" && candidate.id === cursor);
      if (record === undefined) {
        throw new SessionError("invalid_entry", "Session leaf points to a missing entry");
      }
      branch.push(record);
      cursor = record.parentId;
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

  get info(): SessionInfo {
    let title = this.header.title;
    let updatedAt = this.header.createdAt;
    for (const record of this.records) {
      if (record.createdAt > updatedAt) updatedAt = record.createdAt;
      if (record.type === "session_title") title = record.title;
    }
    return {
      id: this.id,
      projectId: this.header.projectId,
      directory: this.header.directory,
      cwd: this.header.cwd,
      title,
      createdAt: this.header.createdAt,
      updatedAt,
    };
  }
}

function parseJson(line: string, path: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new SessionError("invalid_session", "Session file contains invalid JSON", {
      cause: error,
    });
  }
}
