import assert from "node:assert/strict";
import test from "node:test";

import type { AgentToolCall, AgentToolResult } from "../../../src/core/agent/index.js";
import type { HarnessEvent } from "../../../src/core/harness/index.js";

import { Renderer } from "../../../src/ui/cli/renderer.js";

function rendererWith(options: {
  readonly thinking?: "hidden" | "visible";
  readonly toolDetails?: "compact" | "full";
}): { readonly renderer: Renderer; readonly output: () => string; readonly logs: string[] } {
  const chunks: string[] = [];
  const logs: string[] = [];
  const renderer = new Renderer({
    thinking: options.thinking ?? "hidden",
    toolDetails: options.toolDetails ?? "compact",
    write: (text) => chunks.push(text),
    log: (text) => logs.push(text),
  });
  return { renderer, output: () => chunks.join(""), logs };
}

function toolCall(name: string, arguments_: Record<string, unknown>): AgentToolCall {
  return { type: "toolCall", id: "call-1", name, arguments: arguments_ };
}

function toolResult(
  content: string,
  isError = false,
): AgentToolResult {
  return { content, isError };
}

test("thinking is suppressed when hidden and written when visible", () => {
  const hidden = rendererWith({ thinking: "hidden" });
  hidden.renderer.handle({
    type: "thinking-delta",
    runId: "run-1",
    thinking: "secret reasoning",
  });
  assert.equal(hidden.output(), "");

  const visible = rendererWith({ thinking: "visible" });
  visible.renderer.handle({
    type: "thinking-delta",
    runId: "run-1",
    thinking: "visible reasoning",
  });
  assert.ok(visible.output().includes("visible reasoning"));
});

test("compact tool facts omit full result content", () => {
  const { renderer, output } = rendererWith({ toolDetails: "compact" });
  renderer.handle({
    type: "tool-call",
    runId: "run-1",
    cwd: "/repo",
    call: toolCall("bash", { command: "ls -la" }),
  });
  renderer.handle({
    type: "tool-result",
    runId: "run-1",
    cwd: "/repo",
    call: toolCall("bash", { command: "ls -la" }),
    result: toolResult("LONG".repeat(1000)),
  });

  assert.ok(output().includes("bash"));
  assert.ok(output().includes("ls -la"));
  assert.ok(!output().includes("LONG"));
});

test("full tool facts include JSON-safe arguments and result content", () => {
  const { renderer, output } = rendererWith({ toolDetails: "full" });
  renderer.handle({
    type: "tool-call",
    runId: "run-1",
    cwd: "/repo",
    call: toolCall("read_file", { path: "/a/b.txt" }),
  });
  renderer.handle({
    type: "tool-result",
    runId: "run-1",
    cwd: "/repo",
    call: toolCall("read_file", { path: "/a/b.txt" }),
    result: toolResult("file contents"),
  });

  assert.ok(output().includes('"path"'));
  assert.ok(output().includes("file contents"));
});

test("a failed run renders its error once", () => {
  const { renderer, output } = rendererWith({});
  renderer.handle({
    type: "run-end",
    runId: "run-1",
    reason: "error",
    errorMessage: "model exploded",
  });
  assert.equal(output().match(/model exploded/g)?.length, 1);
  assert.ok(output().includes("run failed"));
});

test("serialization failures are reported through the logger", () => {
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const { renderer, logs } = rendererWith({ toolDetails: "full" });

  renderer.handle({
    type: "tool-call",
    runId: "run-1",
    cwd: "/repo",
    call: toolCall("bash", circular),
  });

  assert.ok(logs.some((line) => /renderer error/i.test(line)), logs.join("\n"));
});

test("history renders user, assistant, and tool messages in order", () => {
  const { renderer, output } = rendererWith({});
  renderer.renderHistory([
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "skipped thinking" },
        { type: "text", text: "hi there" },
      ],
      model: "m",
      stopReason: "stop",
      latencyMs: 1,
    },
    { role: "tool", toolCallId: "call-1", name: "bash", content: "tool output", isError: false },
  ]);

  const text = output();
  assert.ok(text.includes("hello"));
  assert.ok(text.includes("hi there"));
  assert.ok(text.includes("tool output"));
  assert.ok(!text.includes("skipped thinking"));
  assert.ok(text.indexOf("hello") < text.indexOf("hi there"));
  assert.ok(text.indexOf("hi there") < text.indexOf("tool output"));
});

test("selections render numbered options and help lists commands", () => {
  const { renderer, output } = rendererWith({});
  renderer.renderSelection("Choose a session:", ["session-a", "session-b"]);
  renderer.renderHelp();

  const text = output();
  assert.ok(text.includes("Choose a session:"));
  assert.ok(text.includes("1. session-a"));
  assert.ok(text.includes("2. session-b"));
  assert.ok(text.includes("/new"));
  assert.ok(text.includes("/session"));
  assert.ok(text.includes("/model"));
  assert.ok(text.includes("/help"));
  assert.ok(text.includes("/exit"));
});

test("user input echo and error messages render plainly", () => {
  const { renderer, output } = rendererWith({});
  renderer.renderUser("hello");
  renderer.renderError("something failed");

  const text = output();
  assert.ok(text.includes("hello"));
  assert.ok(text.includes("something failed"));
});

test("session activation renders a banner and replays history", () => {
  const { renderer, output } = rendererWith({});
  renderer.renderSession({
    sessionId: "session-1",
    model: { provider: "openai", model: "gpt-5" },
    messages: [
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
        model: "m",
        stopReason: "stop",
        latencyMs: 1,
      },
    ],
  });

  const text = output();
  assert.ok(text.includes("Session session-1"));
  assert.ok(text.includes("openai/gpt-5"));
  assert.ok(text.includes("earlier question"));
  assert.ok(text.includes("earlier answer"));
});
