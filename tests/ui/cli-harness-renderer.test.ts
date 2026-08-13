import assert from "node:assert/strict";
import test from "node:test";

import { CliHarnessRenderer } from "../../src/ui/cli-harness-renderer.js";
import { CodingToolPresentationRegistry } from "../../src/coding-agent/ui/presentation-registry.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";

const context = { lane: "main", runId: "run-1" } as const;

function rendererWith(
  presentations: CodingToolPresentationRegistry = new CodingToolPresentationRegistry(),
) {
  const writes: string[] = [];
  const logs: string[] = [];
  const renderer = new CliHarnessRenderer(
    { write: (text) => writes.push(text), log: (text) => logs.push(text) },
    presentations,
  );
  return { renderer, writes, logs };
}

test("ordinary streaming and lifecycle events preserve line CLI behavior", () => {
  const { renderer, writes, logs } = rendererWith();
  renderer.render({ type: "text_delta", text: "hello", ...context });
  renderer.render({ type: "thinking_delta", thinking: "hmm", ...context });
  renderer.render({ type: "toolcall_start", id: "c1", name: "bash", ...context });
  renderer.render({ type: "toolcall_delta", id: "c1", argumentsDelta: "{}", ...context });
  renderer.render({ type: "agent_start", ...context });

  assert.deepEqual(writes, ["hello", "\x1b[90mhmm\x1b[0m", "{}"]);
  assert.deepEqual(logs, ["\n\x1b[33m[tool] bash\x1b[0m"]);
});

test("run lifecycle events are no-output", () => {
  const { renderer, writes, logs } = rendererWith();
  renderer.render({ type: "run_start", ...context });
  renderer.render({ type: "run_end", ...context, reason: "completed" });

  assert.deepEqual(writes, []);
  assert.deepEqual(logs, []);
});

test("tool events are delegated to the presentation registry", () => {
  const presentations = new CodingToolPresentationRegistry();
  presentations.register("todo_write", {
    renderStart: () => "todo start",
    renderEnd: () => "todo end",
    renderRejected: () => "todo rejected",
  });
  const { renderer, logs } = rendererWith(presentations);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  renderer.render({ type: "tool_start", call, ...context });
  renderer.render({ type: "tool_end", call, result: { content: "ok", isError: false }, ...context });
  renderer.render({
    type: "tool_rejected",
    call,
    result: { content: "no", isError: true },
    reason: "blocked",
    ...context,
  });

  assert.deepEqual(logs, [
    "\n\x1b[33mtodo start\x1b[0m",
    "todo end",
    "todo rejected",
  ]);
});

test("tool_end above 100000 characters emits the large-output warning", () => {
  const { renderer, logs } = rendererWith();
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "bash", arguments: {},
  };
  renderer.render({
    type: "tool_end",
    call,
    result: { content: "x".repeat(100_001), isError: false },
    ...context,
  });

  assert.equal(logs.length, 2);
  assert.match(logs[1] ?? "", /Large output from bash \(100001 characters\)/);
});

test("agent_end emits the final tool-count summary", () => {
  const { renderer, logs } = rendererWith();
  renderer.render({
    type: "agent_end",
    messages: [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "c1", name: "bash", content: "one", isError: false },
      { role: "tool", toolCallId: "c2", name: "bash", content: "two", isError: true },
    ],
    ...context,
  });

  assert.deepEqual(logs, ["session used 2 tool calls"]);
});

test("throwing presentations are isolated and never throw through the renderer", () => {
  const presentations = new CodingToolPresentationRegistry();
  presentations.register("todo_write", {
    renderStart: () => { throw new Error("crash"); },
    renderEnd: () => "end",
  });
  const { renderer, logs } = rendererWith(presentations);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  renderer.render({ type: "tool_start", call, ...context });

  assert.deepEqual(logs, ["\n\x1b[33m[exec] todo_write: {}\x1b[0m"]);
});
