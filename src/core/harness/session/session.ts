import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";
import {
  type SessionMetadata,
  type SessionNode,
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

function isModelSelection(value: unknown): value is ModelConfig {
  return isRecord(value) && isString(value.provider) && isString(value.model);
}

function invalidEntry(message: string): never {
  throw new SessionError("invalid_entry", message);
}

function invalidSession(message: string): never {
  throw new SessionError("invalid_session", message);
}

function parseHeader(raw: unknown): StoredSessionHeader {
  if (!isRecord(raw) || raw.type !== "session" || raw.version !== 2 ||
    !isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
    !isString(raw.cwd) || !isAbsolute(raw.cwd) ||
    !isString(raw.title) || !isTimestamp(raw.createdAt) ||
    (raw.parentSessionId !== undefined &&
      (!isString(raw.parentSessionId) || !SESSION_ID_PATTERN.test(raw.parentSessionId)))) {
    invalidSession("Session header is invalid");
  }
  return {
    type: "session",
    version: 2,
    id: raw.id,
    cwd: resolve(raw.cwd),
    title: raw.title,
    createdAt: raw.createdAt,
    ...(raw.parentSessionId !== undefined ? { parentSessionId: raw.parentSessionId } : {}),
  };
}

function parseRow(raw: unknown): StoredSessionRow {
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

  if (raw.type === "model_selection") {
    if (!isString(raw.id) || !SESSION_ID_PATTERN.test(raw.id) ||
      (raw.parentId !== null && (!isString(raw.parentId) || !SESSION_ID_PATTERN.test(raw.parentId))) ||
      !isModelSelection(raw.selection)) {
      return invalidEntry("Session model selection record is invalid");
    }
    return {
      type: "model_selection",
      id: raw.id,
      parentId: raw.parentId as string | null,
      createdAt: raw.createdAt,
      selection: raw.selection,
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

function validateTree(nodes: readonly SessionNode[]): void {
  const byId = new Set<string>();
  let rootCount = 0;

  for (const node of nodes) {
    if (byId.has(node.id)) {
      invalidEntry("Session contains duplicate node IDs");
    }
    if (node.parentId === null) {
      rootCount += 1;
    } else if (!byId.has(node.parentId)) {
      invalidEntry("Session node references a missing parent");
    }
    byId.add(node.id);
  }

  // A fresh Session may contain only a header and no nodes yet.
  if (nodes.length > 0 && rootCount !== 1) {
    invalidEntry("Session nodes must form one rooted tree");
  }
}

/** Directory where one project's session files live, relative to its storageDir. */
export function sessionsDir(storageDir: string): string {
  return join(storageDir, "sessions");
}

/** @internal */
export function sessionPath(storageDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionError("invalid_session", "Session ID is invalid");
  }
  return join(sessionsDir(storageDir), `${sessionId}.jsonl`);
}

function asStorageError(message: string, error: unknown): SessionError {
  return new SessionError("storage", message, { cause: error });
}

interface StoredSessionHeader {
  readonly type: "session";
  readonly version: 2;
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly parentSessionId?: string;
}

interface StoredTitleChange {
  readonly type: "session_title";
  readonly createdAt: string;
  readonly title: string;
}

type StoredSessionRow = SessionNode | StoredTitleChange;

type AppendNode =
  | { readonly type: "message"; readonly message: AgentMessage }
  | { readonly type: "model_selection"; readonly selection: ModelConfig };

export class Session {
  private readonly storedRows: StoredSessionRow[] = [];
  private readonly nodeById = new Map<string, SessionNode>();
  private _headId: string | null = null;
  private pending = Promise.resolve();

  private constructor(
    readonly id: string,
    private readonly persistPath: string | null,
    private readonly header: StoredSessionHeader,
  ) {}

  static inMemory(options: { readonly cwd: string }): Session {
    const header: StoredSessionHeader = {
      type: "session",
      version: 2,
      id: newId(),
      cwd: resolve(options.cwd),
      title: "unknown",
      createdAt: new Date().toISOString(),
    };
    return new Session(header.id, null, header);
  }

  /**
   * Rebuild a Session from validated stored rows. Only the Repository
   * helpers use this; the constructor stays private so Session state changes
   * exclusively through append() after construction.
   *
   * @internal
   */
  static fromStoredRows(
    id: string,
    persistPath: string | null,
    header: StoredSessionHeader,
    rows: readonly StoredSessionRow[],
  ): Session {
    const session = new Session(id, persistPath, header);
    session.storedRows.push(...rows);
    for (const row of rows) {
      if (row.type !== "session_title") {
        session.nodeById.set(row.id, row);
      }
    }
    session._headId = session.nodes.at(-1)?.id ?? null;
    return session;
  }

  get metadata(): SessionMetadata {
    let title = this.header.title;
    let updatedAt = this.header.createdAt;
    for (const row of this.storedRows) {
      if (row.createdAt > updatedAt) updatedAt = row.createdAt;
      if (row.type === "session_title") title = row.title;
    }
    return {
      id: this.id,
      title,
      cwd: this.header.cwd,
      createdAt: this.header.createdAt,
      updatedAt,
      ...(this.header.parentSessionId !== undefined
        ? { parentSessionId: this.header.parentSessionId }
        : {}),
    };
  }

  get headId(): string | null {
    return this._headId;
  }

  get nodes(): readonly SessionNode[] {
    return this.storedRows.filter((row): row is SessionNode => row.type !== "session_title");
  }

  path(nodeId: string | null | undefined = this._headId): readonly SessionNode[] {
    if (nodeId === null) return [];
    const path: SessionNode[] = [];
    let cursor: string | null = nodeId;
    while (cursor !== null) {
      const node = this.nodeById.get(cursor);
      if (node === undefined) {
        throw new SessionError("invalid_entry", `Session node ${cursor} was not found`);
      }
      path.push(node);
      cursor = node.parentId;
    }
    return path.reverse();
  }

  messages(nodeId?: string | null): readonly AgentMessage[] {
    return this.path(nodeId)
      .filter((node): node is Extract<SessionNode, { type: "message" }> => node.type === "message")
      .map((node) => node.message);
  }

  modelSelection(nodeId?: string | null): ModelConfig | null {
    const path = this.path(nodeId);
    for (let index = path.length - 1; index >= 0; index--) {
      const node = path[index]!;
      if (node.type === "model_selection") return node.selection;
    }
    return null;
  }

  async append(node: AppendNode): Promise<string> {
    return this.enqueue(() => this.appendNode(node));
  }

  private async appendNode(input: AppendNode): Promise<string> {
    const node: SessionNode = input.type === "message"
      ? {
          type: "message",
          id: newId(),
          parentId: this._headId,
          createdAt: new Date().toISOString(),
          message: input.message,
        }
      : {
          type: "model_selection",
          id: newId(),
          parentId: this._headId,
          createdAt: new Date().toISOString(),
          selection: input.selection,
        };
    const validated = parseRow(node) as SessionNode;
    const previousHeadId = this._headId;
    this.storedRows.push(validated);
    this.nodeById.set(validated.id, validated);
    this._headId = validated.id;
    try {
      await this.persist(validated);
    } catch (error) {
      this.rollback(validated, previousHeadId);
      throw error;
    }
    return validated.id;
  }

  private rollback(node: SessionNode, previousHeadId: string | null): void {
    const popped = this.storedRows.pop();
    if (popped !== node) {
      throw new Error("Session append rollback lost the appended node");
    }
    this.nodeById.delete(node.id);
    this._headId = previousHeadId;
  }

  private async persist(row: StoredSessionRow): Promise<void> {
    if (this.persistPath === null) return;
    try {
      const file = await open(this.persistPath, "r+");
      try {
        const { size } = await file.stat();
        const contents = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
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
      throw asStorageError("Could not persist session row", error);
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

  private normalizeTitle(title: string): string {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed.includes("\n")) {
      throw new Error("Session title must be a single non-empty line");
    }
    return trimmed;
  }

  async setTitle(title: string): Promise<void> {
    const normalized = this.normalizeTitle(title);
    await this.enqueue(() => this.appendTitle(normalized));
  }

  private async appendTitle(title: string): Promise<void> {
    const row: StoredTitleChange = {
      type: "session_title",
      createdAt: new Date().toISOString(),
      title,
    };
    this.storedRows.push(row);
    try {
      await this.persist(row);
    } catch (error) {
      const popped = this.storedRows.pop();
      if (popped !== row) {
        throw new Error("Session title rollback lost the appended row");
      }
      throw error;
    }
  }

  async setTitleIfUnknown(title: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.metadata.title !== "unknown") return false;
      const normalized = this.normalizeTitle(title);
      await this.appendTitle(normalized);
      return true;
    });
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

/**
 * Create a persistent Session on disk. Only the SessionRepository uses this
 * helper; a fresh Session writes its header with `wx` so a colliding file is
 * rejected, while a fork publishes copied nodes atomically via a temp file.
 *
 * @internal
 */
export async function createPersistentSession(
  storageDir: string,
  options: {
    readonly cwd: string;
    readonly parentSessionId?: string;
    readonly nodes?: readonly SessionNode[];
  },
): Promise<Session> {
  const id = newId();
  const header: StoredSessionHeader = {
    type: "session",
    version: 2,
    id,
    cwd: resolve(options.cwd),
    title: "unknown",
    createdAt: new Date().toISOString(),
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
  };
  const nodes = options.nodes ?? [];
  const path = sessionPath(storageDir, id);
  try {
    await mkdir(sessionsDir(storageDir), { recursive: true });
    if (nodes.length === 0) {
      await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    } else {
      const contents = [
        JSON.stringify(header),
        ...nodes.map((node) => JSON.stringify(node)),
        "",
      ].join("\n");
      const tempPath = join(sessionsDir(storageDir), `.tmp-${id}.jsonl`);
      try {
        await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
        await rename(tempPath, path);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    throw asStorageError("Could not create session storage", error);
  }
  return Session.fromStoredRows(id, path, header, nodes);
}

/**
 * Restore a persistent Session from its JSONL file, validating the header,
 * every stored row, and the node topology. Only the SessionRepository uses
 * this helper.
 *
 * @internal
 */
export async function openPersistentSession(
  storageDir: string,
  sessionId: string,
): Promise<Session> {
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

  const rows: StoredSessionRow[] = [];
  for (let index = 1; index < lines.length; index++) {
    rows.push(parseRow(parseJson(lines[index]!, path)));
  }
  const nodes = rows.filter((row): row is SessionNode => row.type !== "session_title");
  validateTree(nodes);

  return Session.fromStoredRows(sessionId, path, header, rows);
}
