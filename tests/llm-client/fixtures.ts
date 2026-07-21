import type { LLMClient, LLMConfig } from "../../src/llm-client/client.js";
import type {
  LLMResponse,
  Message,
  ToolSchema,
} from "../../src/llm-client/models.js";

export const baseConfig: LLMConfig = {
  model: "test-model",
  apiKey: "test-key",
  baseUrl: null,
  options: { timeout: 120, maxTokens: 8_000 },
};

export const userMessages: Message[] = [{ role: "user", content: "hello" }];

export const commonHistory: Message[] = [
  { role: "system", content: "system one" },
  { role: "system", content: "system two" },
  { role: "user", content: "run pwd" },
  {
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "call-1", name: "bash", arguments: { command: "pwd" } },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-1",
    name: "bash",
    content: "/tmp",
  },
];

export const bashSchema: ToolSchema = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export const textResponse: LLMResponse = {
  model: "test-model",
  content: "ok",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  latencyMs: 0,
  finishReason: "stop",
};

export const fakeClient: LLMClient = {
  async invoke() {
    return textResponse;
  },
  async *stream() {
    yield { type: "text_delta", text: "ok" };
    yield { type: "response_done", response: textResponse };
  },
};

export async function* asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
