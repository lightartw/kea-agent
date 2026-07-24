import { appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Message } from "../../llm-client/types.js";

/** Append one message line to a JSONL session file. */
export async function appendJsonl(
  path: string,
  message: Message,
): Promise<void> {
  await appendFile(path, JSON.stringify(message) + "\n", "utf8");
}

/** Read all messages from a JSONL session file. Returns [] for missing files. */
export async function readJsonl(path: string): Promise<Message[]> {
  const messages: Message[] = [];
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        const raw = JSON.parse(line) as { role: string };
        if (raw.role === "system") continue; // skip legacy system messages
        messages.push(raw as Message);
      }
    }
  } catch (error) {
    // File not found is normal for fresh sessions.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return messages;
}
