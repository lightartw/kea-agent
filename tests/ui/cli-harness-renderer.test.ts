import assert from "node:assert/strict";
import test from "node:test";

import { CliHarnessRenderer } from "../../src/ui/cli-harness-renderer.js";
import type { AgentToolCall } from "../../src/core/agent/tools/types.js";
import type { ToolPresentationInput } from "../../src/coding-agent/ui/presentation.js";
import { Events } from "../../src/core/events/events.js";

const run = { sessionId: "session-1", runId: "run-1" } as const;

function rendererWith(
  renderToolEvent: (event: ToolPresentationInput) => string = (event) =>
    `[${event.type}] ${event.call.name}`,
) {
  const writes: string[] = [];
  const logs: string[] = [];
  const events = new Events();
  const renderer = new CliHarnessRenderer(
    { write: (text) => writes.push(text), log: (text) => logs.push(text) },
    renderToolEvent,
  );
  renderer.bind(events, run.sessionId);
  return { renderer, events, writes, logs };
}

test("ordinary streaming and lifecycle events preserve line CLI behavior", async () => {
  const { events, writes, logs } = rendererWith();
  await events.emit("agent/text-delta", { ...run, text: "hello" });
  await events.emit("agent/thinking-delta", { ...run, thinking: "hmm" });
  await events.emit("agent/tool-call-start", { ...run, id: "c1", name: "bash" });
  await events.emit("agent/tool-call-delta", { ...run, id: "c1", argumentsDelta: "{}" });
  await events.emit("agent/turn-start", run);

  assert.deepEqual(writes, ["hello", "\x1b[90mhmm\x1b[0m", "{}"]);
  assert.deepEqual(logs, ["\n\x1b[33m[tool] bash\x1b[0m"]);
});

test("run-start is no-output and run-end prints the tool-count summary", async () => {
  const { events, writes, logs } = rendererWith();
  await events.emit("harness/run-start", run);
  await events.emit("harness/run-end", { ...run, reason: "completed" });

  assert.deepEqual(writes, []);
  assert.deepEqual(logs, ["session used 0 tool calls"]);
});

test("tool call/result events are delegated to the runtime rendering function", async () => {
  const { events, logs } = rendererWith((event) => {
    if (event.type === "call") return "todo call";
    return "todo result";
  });
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  await events.emit("harness/run-start", run);
  await events.emit("agent/tool-call", { ...run, call });
  await events.emit("agent/tool-result", { ...run, call, result: { content: "ok", isError: false } });

  assert.deepEqual(logs, [
    "\n\x1b[33mtodo call\x1b[0m",
    "todo result",
  ]);
});

test("tool-result above 100000 characters emits the large-output warning", async () => {
  const { events, logs } = rendererWith();
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "bash", arguments: {},
  };
  await events.emit("harness/run-start", run);
  await events.emit("agent/tool-result", {
    ...run,
    call,
    result: { content: "x".repeat(100_001), isError: false },
  });

  assert.equal(logs.length, 2);
  assert.match(logs[1] ?? "", /Large output from bash \(100001 characters\)/);
});

test("run-end emits the final tool-count summary", async () => {
  const { events, logs } = rendererWith();
  await events.emit("harness/run-start", run);
  await events.emit("agent/tool-result", {
    ...run,
    call: { type: "toolCall", id: "c1", name: "bash", arguments: {} },
    result: { content: "one", isError: false },
  });
  await events.emit("agent/tool-result", {
    ...run,
    call: { type: "toolCall", id: "c2", name: "bash", arguments: {} },
    result: { content: "two", isError: true },
  });
  await events.emit("harness/run-end", { ...run, reason: "completed" });

  assert.deepEqual(logs, [
    "[result] bash",
    "[result] bash",
    "session used 2 tool calls",
  ]);
});

test("facts from other sessions are filtered out", async () => {
  const { events, writes, logs } = rendererWith();
  await events.emit("agent/text-delta", { ...run, sessionId: "session-2", text: "ignored" });
  await events.emit("harness/run-end", { ...run, sessionId: "session-2", reason: "completed" });

  assert.deepEqual(writes, []);
  assert.deepEqual(logs, []);
});

test("throwing tool rendering is isolated and never throws through the renderer", async () => {
  const { events, logs } = rendererWith(() => { throw new Error("crash"); });
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  await events.emit("harness/run-start", run);
  await events.emit("agent/tool-call", { ...run, call });

  assert.deepEqual(logs, ["[ui error] crash"]);
});
