import assert from "node:assert/strict";
import test from "node:test";

import { AgentSession } from "../../src/agent/agent-session.js";
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

test("AgentSession owns conversation history across submissions", async () => {
  const session = new AgentSession(client, new ToolRegistry(), [
    { role: "system", content: "system" },
  ]);

  const events = [];
  for await (const event of session.submit("hi")) events.push(event.type);

  assert.deepEqual(events, ["text_delta", "turn_end"]);
  assert.deepEqual(session.messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
  ]);
});
