import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Session, sessionsDir } from "./session.js";
import { SessionError, type SessionMetadata } from "./types.js";

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

export class SessionRepository {
  constructor(readonly storageDir: string) {}

  create(options: { readonly cwd: string }): Promise<Session> {
    return Session.create(this.storageDir, options);
  }

  open(sessionId: string): Promise<Session> {
    return Session.open(this.storageDir, sessionId);
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
        const session = await Session.open(this.storageDir, filename.replace(/\.jsonl$/, ""));
        return session.metadata;
      }),
    );

    sessions.sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      return byUpdated !== 0 ? byUpdated : b.id.localeCompare(a.id);
    });

    return sessions;
  }
}
