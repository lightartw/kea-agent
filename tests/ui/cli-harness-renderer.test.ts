import assert from "node:assert/strict";
import test from "node:test";

import { CliHarnessRenderer } from "../../src/ui/cli-harness-renderer.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";
import type { HarnessToolEvent } from "../../src/harness/events/types.js";

const context = { lane: "main", runId: "run-1" } as const;

function rendererWith(
  renderToolEvent: (event: HarnessToolEvent) => string = (event) =>
    `[${event.type}] ${event.call.name}`,
) {
  const writes: string[] = [];
  const logs: string[] = [];
  const renderer = new CliHarnessRenderer(
    { write: (text) => writes.push(text), log: (text) => logs.push(text) },
    renderToolEvent,
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

test("tool events are delegated to the runtime rendering function", () => {
  const { renderer, logs } = rendererWith((event) => {
    if (event.type === "tool_start") return "todo start";
    if (event.type === "tool_end") return "todo end";
    return "todo rejected";
  });
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

test("throwing tool rendering is isolated and never throws through the renderer", () => {
  const { renderer, logs } = rendererWith(() => { throw new Error("crash"); });
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  renderer.render({ type: "tool_start", call, ...context });

  assert.deepEqual(logs, ["[ui error] crash"]);
});
