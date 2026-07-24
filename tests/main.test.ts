import assert from "node:assert/strict";
import test from "node:test";

import { renderAgentEvent } from "../src/cli/render.js";
import type { LLMResponse } from "../src/llm-client/types.js";

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

test("renderAgentEvent clearly separates tool calls and result previews", () => {
  const logs: string[] = [];
  const log = (text: string): void => { logs.push(text); };
  const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "pwd" } };

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

  assert.equal(logs[0], '\n\u001b[33m[tool] $ bash: {"command":"pwd"}\u001b[0m');
  assert.equal(logs[1], `\u001b[90m[tool result] bash\u001b[0m\n${"x".repeat(200)}`);
});

test("renderAgentEvent labels failed tools as errors", () => {
  const logs: string[] = [];
  const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "bad" } };

  renderAgentEvent(
    {
      type: "tool_end",
      call,
      result: { content: "command failed", isError: true },
    },
    () => undefined,
    (text) => logs.push(text),
  );

  assert.deepEqual(logs, ["\u001b[31m[tool error] bash\u001b[0m\ncommand failed"]);
});
