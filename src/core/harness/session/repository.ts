import { readdir, rm } from "node:fs/promises";

import {
  createPersistentSession,
  openPersistentSession,
  sessionPath,
  sessionsDir,
  type Session,
} from "./session.js";
import { SessionError, type SessionMetadata } from "./types.js";

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

export class SessionRepository {
  constructor(readonly storageDir: string) {}

  create(options: { readonly cwd: string }): Promise<Session> {
    return createPersistentSession(this.storageDir, options);
  }

  open(sessionId: string): Promise<Session> {
    return openPersistentSession(this.storageDir, sessionId);
  }

  /** List all Sessions by stored metadata, newest first. */
  async list(): Promise<readonly SessionMetadata[]> {
    const dir = sessionsDir(this.storageDir);
    let entries: string[];

    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new SessionError("storage", "Could not read sessions directory", {
        cause: error,
      });
    }

    const jsonlFiles = entries.filter(
      (entry) =>
        SESSION_FILE_RE.test(entry) && !entry.startsWith("."),
    );

    const sessions = await Promise.all(
      jsonlFiles.map(async (filename) => {
        const session = await openPersistentSession(this.storageDir, filename.replace(/\.jsonl$/, ""));
        return session.metadata;
      }),
    );

    sessions.sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      return byUpdated !== 0 ? byUpdated : b.id.localeCompare(a.id);
    });

    return sessions;
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
  async delete(sessionId: string): Promise<void> {
    const path = sessionPath(this.storageDir, sessionId);
    try {
      await rm(path, { force: true });
    } catch (error) {
      throw new SessionError("storage", "Could not delete session storage", {
        cause: error,
      });
    }
  }
}
