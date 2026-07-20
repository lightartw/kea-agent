import assert from "node:assert/strict";
import test from "node:test";

import { renderAgentEvent } from "../src/main.js";
import type { LLMResponse } from "../src/llm-client/models.js";

const response: LLMResponse = {
  model: "test-model",
  content: "hello",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  latencyMs: 0,
  finishReason: "stop",
};

test("renderAgentEvent writes text deltas without repeating turn content", () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const write = (text: string): void => { writes.push(text); };
  const log = (text: string): void => { logs.push(text); };

  renderAgentEvent({ type: "text_delta", text: "hello" }, write, log);
  renderAgentEvent({ type: "turn_end", response }, write, log);

  assert.deepEqual(writes, ["hello"]);
  assert.deepEqual(logs, []);
});

test("renderAgentEvent displays tool calls and result previews", () => {
  const logs: string[] = [];
  const log = (text: string): void => { logs.push(text); };
  const call = { id: "c1", name: "bash", arguments: { command: "pwd" } };

  renderAgentEvent({ type: "tool_start", call }, () => undefined, log);
  renderAgentEvent(
    {
      type: "tool_end",
      call,
      result: { content: "x".repeat(250), isError: false },
    },
    () => undefined,
    log,
  );

  assert.equal(logs[0], '\u001b[33m$ bash: {"command":"pwd"}\u001b[0m');
  assert.equal(logs[1], "x".repeat(200));
});
