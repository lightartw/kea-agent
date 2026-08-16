import type {
  AssistantMessage,
  Context,
  Message,
  StreamChunk,
} from "../../src/core/ai/types.js";

export const testModel = { provider: "anthropic", model: "test-model" };

export const userMessages: Message[] = [{ role: "user", content: "hello" }];

export const commonHistory: Message[] = [
  { role: "user", content: "run pwd" },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
    ],
    model: "test-model",
    stopReason: "toolUse",
    latencyMs: 0,
  },
  {
    role: "tool",
    toolCallId: "call-1",
    name: "bash",
    content: "/tmp",
  },
];

export const detailedToolResult: Message = {
  role: "tool",
  toolCallId: "call-1",
  name: "todo_write",
  content: "Current tasks:\n1. [pending] test",
  details: { privateMarker: "must-not-reach-provider" },
  isError: false,
};

export function makeAssistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<Pick<AssistantMessage, "model" | "stopReason" | "latencyMs">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: overrides.model ?? "test-model",
    stopReason: overrides.stopReason ?? "stop",
    latencyMs: overrides.latencyMs ?? 0,
  };
}

export const textMessage: AssistantMessage = makeAssistantMessage([
  { type: "text", text: "ok" },
]);

export async function* asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
