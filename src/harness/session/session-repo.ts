import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "../../ai/types.js";
import type { SessionStore } from "../types.js";
import { Session } from "./session.js";
import { appendEntry } from "./jsonl-storage.js";

function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

/** Create a new empty session backed by a JSONL file under storageDir/sessions/. */
export async function createSessionStore(storageDir: string): Promise<SessionStore> {
  const dir = join(storageDir, "sessions");
  await mkdir(dir, { recursive: true });

  const id = newSessionId();
  const path = join(dir, `${id}.jsonl`);
  const session = new Session(id);

  return {
    session,
    append: async (message: Message) => {
      session.appendMessage(message);
      const entries = session.toJSON();
      await appendEntry(path, entries[entries.length - 1]!);
    },
    load: async () => session.buildContext().messages,
  };
}
