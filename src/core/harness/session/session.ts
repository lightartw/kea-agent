import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";
import type { SessionStorage, StoredSessionRow, StoredTitleChange } from "./storage.js";
import {
  type SessionMetadata,
  type SessionNode,
  SessionError,
} from "./types.js";

/** @internal */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

/** @internal */
export function newId(): string {
  return randomUUID().slice(0, 12);
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** @internal */
export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

/**
 * Validate a node shape and return the normalized node. Both append() and the
 * JSONL backend decode rows through this; malformed entries reject with
 * `invalid_entry`.
 *
 * @internal
 */
export function parseNode(raw: unknown): SessionNode {
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

  return invalidEntry("Session record has an unknown type");
}

/** @internal */
export function validateTree(nodes: readonly SessionNode[]): void {
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

/** A storage that accepts everything, used by in-memory Sessions. */
const NOOP_STORAGE: SessionStorage = {
  appendNode: async () => {},
  setTitle: async () => {},
};

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
    private readonly cwd: string,
    readonly createdAt: string,
    private readonly parentSessionId: string | undefined,
    private title: string,
    private updatedAt: string,
    private readonly storage: SessionStorage,
  ) {}

  /**
   * Rebuild a Session from validated nodes and storage-carried metadata. Only
   * the JSONL backend and tests use this; the constructor stays private so
   * Session state changes exclusively through append() after construction.
   *
   * @internal
   */
  static fromStorage(
    metadata: SessionMetadata,
    nodes: readonly SessionNode[],
    storage: SessionStorage,
  ): Session {
    const session = new Session(
      metadata.id,
      metadata.cwd,
      metadata.createdAt,
      metadata.parentSessionId,
      metadata.title,
      metadata.updatedAt,
      storage,
    );
    for (const node of nodes) {
      session.storedRows.push(node);
      session.nodeById.set(node.id, node);
    }
    session._headId = nodes.at(-1)?.id ?? null;
    return session;
  }

  static inMemory(options: { readonly cwd: string }): Session {
    const now = new Date().toISOString();
    return new Session(newId(), resolve(options.cwd), now, undefined, "unknown", now, NOOP_STORAGE);
  }

  get metadata(): SessionMetadata {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.parentSessionId !== undefined
        ? { parentSessionId: this.parentSessionId }
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
    return this.enqueue(async () => {
      const full: SessionNode = node.type === "message"
        ? {
            type: "message",
            id: newId(),
            parentId: this._headId,
            createdAt: new Date().toISOString(),
            message: node.message,
          }
        : {
            type: "model_selection",
            id: newId(),
            parentId: this._headId,
            createdAt: new Date().toISOString(),
            selection: node.selection,
          };
      parseNode(full);
      await this.storage.appendNode(full);
      this.storedRows.push(full);
      this.nodeById.set(full.id, full);
      this._headId = full.id;
      this.updatedAt = full.createdAt;
      return full.id;
    });
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
    const createdAt = new Date().toISOString();
    await this.storage.setTitle(title, createdAt);
    this.storedRows.push({ type: "session_title", createdAt, title });
    this.title = title;
    this.updatedAt = createdAt;
  }

  async setTitleIfUnknown(title: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.title !== "unknown") return false;
      await this.appendTitle(this.normalizeTitle(title));
      return true;
    });
  }
}
