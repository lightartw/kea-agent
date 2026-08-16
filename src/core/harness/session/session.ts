import { resolve } from "node:path";

import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";
import { newId, parseSessionRecord } from "./records.js";
import {
  SessionError,
  type SessionMetadata,
  type SessionNode,
  type SessionRecord,
  type SessionStorage,
} from "./types.js";

type AppendNode =
  | { readonly type: "message"; readonly message: AgentMessage }
  | { readonly type: "model_selection"; readonly selection: ModelConfig };

/**
 * One Session's in-memory state and behavior. Records and projections are
 * owned here; durable acceptance is delegated to the shared SessionStorage.
 */
export class Session {
  private readonly records: SessionRecord[];
  private readonly nodeById = new Map<string, SessionNode>();
  private _headId: string | null = null;
  private metadataState: SessionMetadata;
  private readonly storage: SessionStorage | undefined;
  private pending: Promise<void> = Promise.resolve();

  private constructor(options: {
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
    readonly storage?: SessionStorage;
  }) {
    this.metadataState = { ...options.metadata };
    this.records = [];
    this.storage = options.storage;
    for (const record of options.records) {
      this.apply(structuredClone(record));
    }
  }

  static inMemory(options: { readonly cwd: string }): Session {
    const now = new Date().toISOString();
    return new Session({
      metadata: {
        id: newId(),
        title: "unknown",
        cwd: resolve(options.cwd),
        createdAt: now,
        updatedAt: now,
      },
      records: [],
    });
  }

  /**
   * Build a Session from data already accepted by SessionStorage. Performs no
   * validation and no I/O; storage load/create and Session.append validate
   * before this construction path.
   *
   * @internal
   */
  static fromStorage(
    stored: {
      readonly metadata: SessionMetadata;
      readonly records: readonly SessionRecord[];
    },
    storage: SessionStorage,
  ): Session {
    return new Session({ metadata: stored.metadata, records: stored.records, storage });
  }

  get id(): string {
    return this.metadataState.id;
  }

  get metadata(): SessionMetadata {
    return { ...this.metadataState };
  }

  get headId(): string | null {
    return this._headId;
  }

  get nodes(): readonly SessionNode[] {
    return this.records.filter((record): record is SessionNode => record.type !== "session_title");
  }

  path(nodeId: string | null | undefined = this._headId): readonly SessionNode[] {
    if (nodeId === null) return [];
    const path: SessionNode[] = [];
    let cursor: string | null = nodeId;
    while (cursor !== null) {
      const node = this.nodeById.get(cursor);
      if (node === undefined) {
        throw new SessionError("not_found", `Session node ${cursor} was not found`);
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

  append(input: AppendNode): Promise<string> {
    return this.enqueue(async () => {
      const record: SessionRecord = input.type === "message"
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
      const parsed = parseSessionRecord(record);
      if (parsed.type === "session_title") {
        throw new Error("Node append produced a title record");
      }
      await this.commit(parsed);
      return parsed.id;
    });
  }

  setTitle(title: string): Promise<void> {
    const normalized = this.normalizeTitle(title);
    return this.enqueue(async () => {
      await this.commit({
        type: "session_title",
        createdAt: new Date().toISOString(),
        title: normalized,
      });
    });
  }

  setTitleIfUnknown(title: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.metadataState.title !== "unknown") return false;
      const normalized = this.normalizeTitle(title);
      await this.commit({
        type: "session_title",
        createdAt: new Date().toISOString(),
        title: normalized,
      });
      return true;
    });
  }

  /** Durable append when storage exists, then apply to memory. */
  private async commit(record: SessionRecord): Promise<void> {
    if (this.storage !== undefined) {
      await this.storage.append(this.id, record);
    }
    this.apply(record);
  }

  /** Update records plus the relevant node/head/title/updatedAt projection. */
  private apply(record: SessionRecord): void {
    this.records.push(record);
    this.metadataState = {
      ...this.metadataState,
      updatedAt: record.createdAt > this.metadataState.updatedAt
        ? record.createdAt
        : this.metadataState.updatedAt,
      ...(record.type === "session_title" ? { title: record.title } : {}),
    };
    if (record.type !== "session_title") {
      this.nodeById.set(record.id, record);
      this._headId = record.id;
    }
  }

  /** Serialize mutations and allow later work after a rejected operation. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Enforce one non-empty trimmed line. */
  private normalizeTitle(title: string): string {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed.includes("\n")) {
      throw new SessionError("invalid_record", "Session title must be a single non-empty line");
    }
    return trimmed;
  }
}
