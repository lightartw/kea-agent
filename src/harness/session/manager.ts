import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessProject } from "../types.js";
import { Session, sessionsDir } from "./session.js";
import { SessionError } from "./types.js";

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

export class SessionManager {
  constructor(readonly project: HarnessProject) {}

  /** Open the most recently modified session, or create a new one if none exist. */
  async continueRecent(): Promise<Session> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) {
      return Session.create(this.project.storageDir);
    }
    return Session.open(this.project.storageDir, sessions[0]!);
  }

  /** List all session IDs, newest first. */
  async listSessions(): Promise<string[]> {
    const dir = sessionsDir(this.project.storageDir);
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
