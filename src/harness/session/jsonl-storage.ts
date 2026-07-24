import { appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "../../llm-client/types.js";

/** Assert that a parsed JSON object is a valid Message via role discriminator. */
function assertMessage(raw: Record<string, unknown>): Message {
  if (raw.role === "user") {
    if (typeof raw.content !== "string") throw new Error("Invalid UserMessage: content must be string");
    return raw as unknown as UserMessage;
  }
  if (raw.role === "assistant") {
    if (!Array.isArray(raw.content)) throw new Error("Invalid AssistantMessage: content must be array");
    if (typeof raw.model !== "string") throw new Error("Invalid AssistantMessage: model must be string");
    if (typeof raw.stopReason !== "string") throw new Error("Invalid AssistantMessage: stopReason must be string");
    if (typeof raw.latencyMs !== "number") throw new Error("Invalid AssistantMessage: latencyMs must be number");
    return raw as unknown as AssistantMessage;
  }
  if (raw.role === "tool") {
    if (typeof raw.toolCallId !== "string") throw new Error("Invalid ToolResultMessage: toolCallId must be string");
    if (typeof raw.name !== "string") throw new Error("Invalid ToolResultMessage: name must be string");
    return raw as unknown as ToolResultMessage;
  }
  throw new Error(`Invalid message: unknown role "${String(raw.role)}"`);
}

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
    let isFirst = true;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (isFirst) {
        isFirst = false;
        messages.push(assertMessage(raw));
        continue;
      }
      if (raw.role === "system") continue; // skip legacy system messages
      messages.push(assertMessage(raw));
    }
  } catch (error) {
    // File not found is normal for fresh sessions.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return messages;
}
