import type { Session } from "./session.js";
import {
  createPersistentSession,
  deleteSession,
  listSessions,
  openPersistentSession,
} from "./storage.js";
import type { SessionMetadata } from "./types.js";

export class SessionRepository {
  constructor(readonly storageDir: string) {}

  create(options: { readonly cwd: string }): Promise<Session> {
    return createPersistentSession(this.storageDir, options);
  }

  open(sessionId: string): Promise<Session> {
    return openPersistentSession(this.storageDir, sessionId);
  }

  /** List all Sessions by stored metadata, newest first. */
  list(): Promise<readonly SessionMetadata[]> {
    return listSessions(this.storageDir);
  }

  /**
   * Create a new Session seeded with the root-to-node path of another Session.
   * Copied nodes keep their IDs and parent links; the fork gets a fresh
   * Session ID, a new timestamp, and records `parentSessionId`. `null` seeds
   * an empty Session.
   */
  async fork(sourceSessionId: string, nodeId: string | null): Promise<Session> {
    const source = await this.open(sourceSessionId);
    const path = source.path(nodeId);
    return createPersistentSession(this.storageDir, {
      cwd: source.metadata.cwd,
      parentSessionId: sourceSessionId,
      nodes: path,
    });
  }

  /** Delete one Session file; a missing Session is already deleted. */
  delete(sessionId: string): Promise<void> {
    return deleteSession(this.storageDir, sessionId);
  }
}
