import { appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "../../ai/types.js";
import type { MessageEntry, ModelChangeEntry, SessionEntry } from "./session.js";

/** Assert that a parsed JSON object is a valid SessionEntry via type discriminator. */
function assertEntry(raw: Record<string, unknown>): SessionEntry {
  if (raw.type === "message") {
    return raw as unknown as MessageEntry;
  }
  if (raw.type === "model_change") {
    if (typeof raw.provider !== "string") throw new Error("Invalid ModelChangeEntry: provider must be string");
    if (typeof raw.modelId !== "string") throw new Error("Invalid ModelChangeEntry: modelId must be string");
    return raw as unknown as ModelChangeEntry;
  }
  // Legacy: bare Message objects (flat JSONL without entry wrapper)
  if (raw.role === "user") {
    if (typeof raw.content !== "string") throw new Error("Invalid UserMessage: content must be string");
    return raw as unknown as MessageEntry;
  }
  if (raw.role === "assistant") {
    if (!Array.isArray(raw.content)) throw new Error("Invalid AssistantMessage: content must be array");
    return raw as unknown as MessageEntry;
  }
  if (raw.role === "tool") {
    return raw as unknown as MessageEntry;
  }
  throw new Error(`Invalid session entry: unknown type "${String(raw.type ?? raw.role)}"`);
}

/** Append one entry to a JSONL session file. */
export async function appendEntry(
  path: string,
  entry: SessionEntry,
): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

/** Read all entries from a JSONL session file. Returns [] for missing files. */
export async function readEntries(path: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as Record<string, unknown>;
      entries.push(assertEntry(raw));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return entries;
}
