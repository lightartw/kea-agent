import assert from "node:assert/strict";
import test from "node:test";

import { CodingToolPresentationRegistry } from "../../../src/coding-agent/ui/presentation.js";
import type { ToolPresentationInput } from "../../../src/coding-agent/ui/presentation.js";
import type { AgentToolCall } from "../../../src/agent/tools/types.js";

const todoCall: AgentToolCall = {
  type: "toolCall", id: "c1", name: "todo_write", arguments: {},
};
const bashCall: AgentToolCall = {
  type: "toolCall", id: "c2", name: "bash", arguments: {},
};

function todoResult(result: { content: string; isError: boolean }): ToolPresentationInput {
  return { type: "result", call: todoCall, result };
}

test("registry matches by tool name and falls back for unknown tools", () => {
  const errors: string[] = [];
  const registry = new CodingToolPresentationRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderCall: () => "todo call",
    renderResult: () => "todo result",
  });

  assert.equal(registry.render({ type: "call", call: todoCall }), "todo call");
  assert.equal(registry.render(todoResult({ content: "ok", isError: false })), "todo result");
  assert.equal(registry.render({ type: "call", call: bashCall }), "[exec] bash: {}");
  assert.deepEqual(errors, []);
});

test("registry falls back when presentation returns undefined or throws", () => {
  const errors: string[] = [];
  const registry = new CodingToolPresentationRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderCall: () => undefined,
    renderResult: () => { throw new Error("boom"); },
  });

  assert.equal(
    registry.render({ type: "call", call: todoCall }),
    "[exec] todo_write: {}",
  );
  assert.equal(
    registry.render(todoResult({ content: "ok", isError: false })),
    "[done] todo_write: ok",
  );
  assert.deepEqual(errors, ["boom"]);
});

test("result fallback reflects the error flag", () => {
  const registry = new CodingToolPresentationRegistry();
  assert.equal(
    registry.render(todoResult({ content: "failed", isError: true })),
    "[error] todo_write: failed",
  );
  assert.equal(
    registry.render(todoResult({ content: "ok", isError: false })),
    "[done] todo_write: ok",
  );
});

test("duplicate registration throws", () => {
  const registry = new CodingToolPresentationRegistry();
  registry.register("todo_write", { renderCall: () => "x", renderResult: () => "y" });
  assert.throws(
    () => registry.register("todo_write", { renderCall: () => "z", renderResult: () => "w" }),
    /already registered/,
  );
});

test("fallback rendering never throws for non-JSON-safe arguments", () => {
  const registry = new CodingToolPresentationRegistry();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assert.doesNotThrow(() => registry.render({
    type: "call",
    call: { type: "toolCall", id: "c1", name: "unknown", arguments: cyclic },
  }));
  assert.match(registry.render({
    type: "call",
    call: { type: "toolCall", id: "c2", name: "unknown", arguments: { value: 1n } },
  }), /unknown/);
});
