import assert from "node:assert/strict";
import test from "node:test";

import { renderAgentEvent } from "../src/cli/render.js";
import { AgentHarness } from "../src/agent/harness/agent-harness.js";
import { Session } from "../src/agent/harness/session/session.js";
import { AgentToolRegistry } from "../src/agent/tools/registry.js";
import type { AssistantMessage, StreamFn } from "../src/ai/types.js";

const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

test("renderAgentEvent writes text deltas without repeating turn content", () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const write = (text: string): void => { writes.push(text); };
  const log = (text: string): void => { logs.push(text); };

  renderAgentEvent({ type: "text_delta", text: "hello" }, write, log);
  renderAgentEvent({ type: "turn_end", message }, write, log);

  assert.deepEqual(writes, ["hello"]);
  assert.deepEqual(logs, []);
});

test("renderAgentEvent logs tool_start with exec prefix", () => {
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

  assert.equal(logs[0], '\n\x1b[33m[exec] bash: {"command":"pwd"}\x1b[0m');
  assert.equal(logs.length, 1);
});

test("renderAgentEvent tool_end is a no-op in current renderer", () => {
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

  assert.deepEqual(logs, []);
});

test("Harness renders through one subscription while prompt returns a Promise", async () => {
  const rendered: string[] = [];
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "hello" };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        latencyMs: 0,
      },
    };
  };
  const harness = new AgentHarness({
    session: Session.inMemory(),
    model: { provider: "test", model: "test" },
    streamFn: stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: () => "",
    cwd: process.cwd(),
  });
  const unsubscribe = harness.subscribe((event) => {
    renderAgentEvent(event, (text) => rendered.push(text), () => undefined);
  });

  const run: Promise<void> = harness.prompt("hello");
  await run;
  unsubscribe();

  assert.deepEqual(rendered, ["hello"]);
});
