import { resolve } from "node:path";

import type { AgentMessage } from "../types.js";
import type { ModelConfig } from "../../ai/types.js";
import { newId, parseSessionRecord } from "./records.js";
import {
  SessionError,
  type SessionMetadata,
  type SessionNode,
  type SessionStorage,
} from "./types.js";

/**
 * One Session's in-memory state and behavior. Logical nodes and metadata are
 * owned here; durable acceptance is delegated to the shared SessionStorage.
 */
export class Session {
  private readonly nodeById = new Map<string, SessionNode>();
  private _headId: string | null = null;
  private metadataState: SessionMetadata;
  private readonly storage: SessionStorage | undefined;

  private constructor(options: {
    readonly metadata: SessionMetadata;
    readonly nodes: readonly SessionNode[];
    readonly storage?: SessionStorage;
  }) {
    this.metadataState = { ...options.metadata };
    this.storage = options.storage;
    for (const storedNode of options.nodes) {
      const node = structuredClone(storedNode);
      this.nodeById.set(node.id, node);
      this._headId = node.id;
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
      nodes: [],
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
      readonly nodes: readonly SessionNode[];
    },
    storage: SessionStorage,
  ): Session {
    return new Session({ metadata: stored.metadata, nodes: stored.nodes, storage });
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
    return [...this.nodeById.values()];
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

  async append(input:
    | { readonly type: "message"; readonly message: AgentMessage }
    | { readonly type: "model_selection"; readonly selection: ModelConfig }
  ): Promise<string> {
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
    const parsed = parseSessionRecord(node);
    await this.commit(parsed);
    return parsed.id;
  }

  async setTitle(title: string): Promise<void> {
    const normalized = this.normalizeTitle(title);
    if (this.storage !== undefined) {
      await this.storage.setTitle(this.id, normalized);
    }
    this.metadataState = {
      ...this.metadataState,
      title: normalized,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Durable append when storage exists, then apply to memory. */
  private async commit(node: SessionNode): Promise<void> {
    if (this.storage !== undefined) {
      await this.storage.append(this.id, node);
    }
    this.apply(node);
  }

  /** Apply one accepted node to logical Session state. */
  private apply(node: SessionNode): void {
    this.metadataState = {
      ...this.metadataState,
      updatedAt: node.createdAt > this.metadataState.updatedAt
        ? node.createdAt
        : this.metadataState.updatedAt,
    };
    this.nodeById.set(node.id, node);
    this._headId = node.id;
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
