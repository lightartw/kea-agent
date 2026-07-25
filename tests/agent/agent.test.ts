import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../../src/agent/agent.js";
import type { ModelConfig, StreamFn } from "../../src/ai/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";

const testModel: ModelConfig = { provider: "test", model: "test-model" };

const assistantMsg = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "hello" }],
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop" as const,
  latencyMs: 0,
};

const streamFn: StreamFn = async function* () {
  yield { type: "text_delta", text: "hello" };
  yield { type: "done", message: assistantMsg };
};

test("Agent owns conversation history across prompts", async () => {
  const agent = new Agent(streamFn, testModel, new AgentToolRegistry(), [], "system prompt");

  const events = [];
  for await (const event of agent.prompt("hi")) events.push(event.type);

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "text_delta",
    "turn_end",
    "agent_end",
  ]);
  assert.deepEqual(
    agent.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});
