import assert from "node:assert/strict";
import test from "node:test";

import { CliHarnessRenderer } from "../../src/ui/cli-harness-renderer.js";
import type { AgentToolCall } from "../../src/core/agent/tools/types.js";
import { Events } from "../../src/core/events/events.js";

const run = { sessionId: "session-1", runId: "run-1", cwd: "/work/project" } as const;

function rendererWith() {
  const writes: string[] = [];
  const logs: string[] = [];
  const events = new Events();
  const renderer = new CliHarnessRenderer(
    { write: (text) => writes.push(text), log: (text) => logs.push(text) },
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

test("tool call/result events render arguments and results directly", async () => {
  const { events, logs } = rendererWith();
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: { path: "a.ts" },
  };

  await events.emit("harness/run-start", run);
  await events.emit("agent/tool-call", { ...run, call });
  await events.emit("agent/tool-result", {
    ...run,
    call,
    result: { content: "ok", isError: false },
  });

  assert.deepEqual(logs, [
    "\x1b[33m  {\"path\":\"a.ts\"}\x1b[0m",
    "\n\x1b[32m[result] todo_write\x1b[0m",
    "ok",
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

  assert.equal(logs.length, 3);
  assert.match(logs[2] ?? "", /Large output from bash \(100001 characters\)/);
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
    "\n\x1b[32m[result] bash\x1b[0m",
    "one",
    "\n\x1b[31m[result] bash\x1b[0m",
    "two",
    "session used 2 tool calls",
  ]);
});

test("run failure is rendered after the tool-count summary", async () => {
  const { events, logs } = rendererWith();
  await events.emit("harness/run-start", run);
  await events.emit("harness/run-end", {
    ...run,
    reason: "error",
    errorMessage: "boom",
  });

  assert.deepEqual(logs, [
    "session used 0 tool calls",
    "\x1b[31mrun failed: boom\x1b[0m",
  ]);
});

test("large arguments are truncated in the tool-call preview", async () => {
  const { events, logs } = rendererWith();
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "bash",
    arguments: { command: "x".repeat(500) },
  };

  await events.emit("harness/run-start", run);
  await events.emit("agent/tool-call", { ...run, call });

  const line = logs[0] ?? "";
  assert.ok(line.includes("…"));
  assert.ok(line.length < 250);
});

test("facts from other sessions are filtered out", async () => {
  const { events, writes, logs } = rendererWith();
  await events.emit("agent/text-delta", { ...run, sessionId: "session-2", text: "ignored" });
  await events.emit("harness/run-end", { ...run, sessionId: "session-2", reason: "completed" });

  assert.deepEqual(writes, []);
  assert.deepEqual(logs, []);
});
