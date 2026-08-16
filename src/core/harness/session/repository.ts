import { resolve } from "node:path";

import { newId } from "./records.js";
import { Session } from "./session.js";
import { JsonlSessionStorage } from "./storage.js";
import type { SessionMetadata, SessionNode, SessionStorage } from "./types.js";

/**
 * Lifecycle orchestration for all Sessions in one Project. Owns exactly one
 * SessionStorage backend and composes durable data with Session objects; it
 * performs no direct filesystem operation.
 */
export class SessionRepository {
  private readonly storage: SessionStorage;

  constructor(storageDir: string) {
    this.storage = new JsonlSessionStorage(storageDir);
  }

  async create(options: { readonly cwd: string }): Promise<Session> {
    const now = new Date().toISOString();
    const stored = {
      metadata: {
        id: newId(),
        title: "unknown",
        cwd: resolve(options.cwd),
        createdAt: now,
        updatedAt: now,
      },
      nodes: [] as readonly SessionNode[],
    };
    await this.storage.create(stored);
    return Session.fromStorage(stored, this.storage);
  }

  async open(sessionId: string): Promise<Session> {
    const stored = await this.storage.load(sessionId);
    return Session.fromStorage(stored, this.storage);
  }

  list(): Promise<readonly SessionMetadata[]> {
    return this.storage.list();
  }

  /**
   * Create a new Session seeded with the root-to-node path of another Session.
   * Copied nodes keep their IDs and parent links; the fork gets a fresh
   * Session ID, a new timestamp, and records `parentSessionId`. `null` seeds
   * an empty Session.
   */
  async fork(sourceSessionId: string, nodeId: string | null): Promise<Session> {
    const source = await this.open(sourceSessionId);
    const nodes = source.path(nodeId);
    const now = new Date().toISOString();
    const stored = {
      metadata: {
        id: newId(),
        title: "unknown",
        cwd: source.metadata.cwd,
        createdAt: now,
        updatedAt: now,
        parentSessionId: sourceSessionId,
      },
      nodes,
    };
    await this.storage.create(stored);
    return Session.fromStorage(stored, this.storage);
  }

  /** Delete one Session artifact; a missing Session is already deleted. */
  delete(sessionId: string): Promise<void> {
    return this.storage.delete(sessionId);
  }
}
