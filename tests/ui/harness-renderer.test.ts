import assert from "node:assert/strict";
import test from "node:test";

import { CliHarnessRenderer } from "../../src/ui/harness-renderer.js";
import { CliToolRendererRegistry } from "../../src/ui/tool-renderers.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";

function rendererWith(tools: CliToolRendererRegistry = new CliToolRendererRegistry(() => undefined)) {
  const writes: string[] = [];
  const logs: string[] = [];
  const renderer = new CliHarnessRenderer(
    { write: (text) => writes.push(text), log: (text) => logs.push(text) },
    tools,
  );
  return { renderer, writes, logs };
}

test("ordinary streaming and lifecycle events preserve line CLI behavior", () => {
  const { renderer, writes, logs } = rendererWith();
  renderer.render({ type: "text_delta", text: "hello" });
  renderer.render({ type: "thinking_delta", thinking: "hmm" });
  renderer.render({ type: "toolcall_start", id: "c1", name: "bash" });
  renderer.render({ type: "toolcall_delta", id: "c1", argumentsDelta: "{}" });
  renderer.render({ type: "agent_start" });

  assert.deepEqual(writes, ["hello", "\x1b[90mhmm\x1b[0m", "{}"]);
  assert.deepEqual(logs, ["\n\x1b[33m[tool] bash\x1b[0m"]);
});

test("tool events are delegated to the Tool Registry", () => {
  const registry = new CliToolRendererRegistry(() => undefined);
  registry.register("todo_write", {
    renderStart: () => "todo start",
    renderEnd: () => "todo end",
    renderRejected: () => "todo rejected",
  });
  const { renderer, logs } = rendererWith(registry);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  renderer.render({ type: "tool_start", call });
  renderer.render({ type: "tool_end", call, result: { content: "ok", isError: false } });
  renderer.render({
    type: "tool_rejected",
    call,
    result: { content: "no", isError: true },
    reason: "blocked",
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
  });

  assert.deepEqual(logs, ["session used 2 tool calls"]);
});

test("rendering failures never throw back through the renderer", () => {
  const registry = new CliToolRendererRegistry((message) => {
    throw new Error(`onError: ${message}`);
  });
  registry.register("todo_write", {
    renderStart: () => { throw new Error("crash"); },
    renderEnd: () => "end",
  });
  const { renderer, logs } = rendererWith(registry);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "todo_write", arguments: {},
  };

  renderer.render({ type: "tool_start", call });

  assert.match(logs.join("\n"), /\[ui error\] onError: crash/);
});
