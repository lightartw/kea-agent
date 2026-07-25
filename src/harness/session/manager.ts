import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessProject } from "../types.js";
import { Session } from "./session.js";
import { SessionError } from "./types.js";

const SESSION_FILE_RE = /^[A-Za-z0-9_-]+\.jsonl$/;

export class SessionManager {
  readonly project: HarnessProject;

  private constructor(project: HarnessProject) {
    this.project = project;
  }

  /** Ensure the project's sessions directory exists and return a manager. */
  static async create(project: HarnessProject): Promise<SessionManager> {
    try {
      await mkdir(join(project.storageDir, "sessions"), { recursive: true });
    } catch (error) {
      throw new SessionError("storage", "Could not create sessions directory", {
        cause: error,
      });
    }
    return new SessionManager(project);
  }

  /** Always create a new session. */
  async createSession(): Promise<Session> {
    return Session.create(this.project.storageDir);
  }

  /** Open an existing session by its ID (filename stem without .jsonl). */
  async openSession(sessionId: string): Promise<Session> {
    return Session.open(this.project.storageDir, sessionId);
  }

  /** Open the most recently modified session, or create a new one if none exist. */
  async continueRecent(): Promise<Session> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) {
      return this.createSession();
    }
    return this.openSession(sessions[0]!);
  }

  /** List all session IDs, newest first. */
  async listSessions(): Promise<string[]> {
    const sessionsDir = join(this.project.storageDir, "sessions");
    let entries: string[];

    try {
      entries = await readdir(sessionsDir);
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
          const s = await stat(join(sessionsDir, filename));
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
