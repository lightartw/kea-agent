import type {
  AssistantMessage,
  ContentBlock,
  LLMClient,
  LLMConfig,
  Message,
} from "../../src/llm-client/types.js";

export const baseConfig: LLMConfig = {
  model: "test-model",
  apiKey: "test-key",
  baseUrl: null,
  options: { timeout: 120, maxTokens: 8_000 },
};

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

export function makeAssistantMessage(
  content: ContentBlock[],
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

export const fakeClient: LLMClient = {
  async *stream() {
    yield { type: "text_delta", text: "ok" };
    yield { type: "done", message: textMessage };
  },
};

export async function* asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
