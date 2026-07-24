import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../../src/agent/agent.js";
import type { LLMClient, LLMResponse } from "../../src/llm-client/types.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";

const response: LLMResponse = {
  model: "test-model",
  content: "hello",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  latencyMs: 0,
  finishReason: "stop",
};

const client: LLMClient = {
  async invoke() {
    return response;
  },
  async *stream() {
    yield { type: "text_delta", text: "hello" } as const;
    yield { type: "response_done", response } as const;
  },
};

test("Agent owns conversation history across prompts", async () => {
  const agent = new Agent(client, new ToolRegistry(), [], "system prompt");

  const events = [];
  for await (const event of agent.prompt("hi")) events.push(event.type);

  assert.deepEqual(events, ["text_delta", "turn_end"]);
  assert.deepEqual(
    agent.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});
