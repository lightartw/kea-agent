import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { Session, sessionsDir } from "./session.js";
import { SessionError } from "./types.js";

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

export class SessionRepository {
  constructor(readonly storageDir: string) {}

  create(): Promise<Session> {
    return Session.create(this.storageDir);
  }

  open(sessionId: string): Promise<Session> {
    return Session.open(this.storageDir, sessionId);
  }

  /** List all session IDs, newest first. */
  async list(): Promise<readonly string[]> {
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

    if (jsonlFiles.length === 0) return [];

    const stats = await Promise.all(
      jsonlFiles.map(async (filename) => {
        try {
          const s = await stat(join(dir, filename));
          return { filename, mtimeMs: s.mtimeMs };
        } catch {
          return { filename, mtimeMs: 0 };
        }
      }),
    );

    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return stats.map((s) => s.filename.replace(/\.jsonl$/, ""));
  }
}
