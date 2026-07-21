import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "../../../llm-client/types.js";
import type { Project, SessionStore } from "../types.js";
import { appendJsonl, readJsonl } from "./jsonl-storage.js";

function sessionsDir(project: Project): string {
  return join(project.storageDir, "sessions");
}

function sessionPath(project: Project, sessionId: string): string {
  return join(sessionsDir(project), `${sessionId}.jsonl`);
}

function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

/** Manages JSONL session files under ~/.kea/projects/<id>/sessions/. */
export class SessionRepo {
  constructor(private readonly project: Project) {}

  /** Create a new empty session, ready for messages to be appended. */
  async create(): Promise<SessionStore> {
    await mkdir(sessionsDir(this.project), { recursive: true });
    const id = newSessionId();
    const path = sessionPath(this.project, id);
    const messages: Message[] = [];
    // Write a header line so the file exists.
    await appendJsonl(path, {
      role: "system",
      content: `session:${id}`,
    } as Message);
    return {
      append: async (message: Message) => {
        messages.push(message);
        await appendJsonl(path, message);
      },
      load: async () => {
        return (await readJsonl(path)).slice(1); // skip header
      },
    };
  }

  /** Open existing session by ID. */
  async open(sessionId: string): Promise<SessionStore> {
    const path = sessionPath(this.project, sessionId);
    const stored = await readJsonl(path);
    const messages = stored.slice(1); // skip header
    return {
      append: async (message: Message) => {
        messages.push(message);
        await appendJsonl(path, message);
      },
      load: async () => [...messages],
    };
  }
}
