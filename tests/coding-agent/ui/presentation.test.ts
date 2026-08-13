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

function todoEnd(result: { content: string; isError: boolean }): ToolPresentationInput {
  return { type: "tool_end", call: todoCall, result };
}

test("registry matches by tool name and falls back for unknown tools", () => {
  const errors: string[] = [];
  const registry = new CodingToolPresentationRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderStart: () => "todo start",
    renderEnd: () => "todo end",
    renderRejected: () => "todo rejected",
  });

  assert.equal(registry.render({ type: "tool_start", call: todoCall }), "todo start");
  assert.equal(registry.render(todoEnd({ content: "ok", isError: false })), "todo end");
  assert.equal(registry.render({
    type: "tool_rejected",
    call: todoCall,
    result: { content: "no", isError: true },
    reason: "blocked",
  }), "todo rejected");
  assert.equal(registry.render({ type: "tool_start", call: bashCall }), "[exec] bash: {}");
  assert.deepEqual(errors, []);
});

test("registry falls back when presentation returns undefined or throws", () => {
  const errors: string[] = [];
  const registry = new CodingToolPresentationRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderStart: () => undefined,
    renderEnd: () => { throw new Error("boom"); },
  });

  assert.equal(
    registry.render({ type: "tool_start", call: todoCall }),
    "[exec] todo_write: {}",
  );
  assert.equal(
    registry.render(todoEnd({ content: "ok", isError: false })),
    "[done] todo_write: ok",
  );
  assert.deepEqual(errors, ["boom"]);
});

test("tool_end fallback reflects the error flag and rejected uses the reason", () => {
  const registry = new CodingToolPresentationRegistry();
  assert.equal(
    registry.render(todoEnd({ content: "failed", isError: true })),
    "[error] todo_write: failed",
  );
  assert.equal(
    registry.render({
      type: "tool_rejected",
      call: todoCall,
      result: { content: "denied", isError: true },
      reason: "blocked",
    }),
    "[rejected:blocked] todo_write: denied",
  );
});

test("duplicate registration throws", () => {
  const registry = new CodingToolPresentationRegistry();
  registry.register("todo_write", { renderStart: () => "x", renderEnd: () => "y" });
  assert.throws(
    () => registry.register("todo_write", { renderStart: () => "z", renderEnd: () => "w" }),
    /already registered/,
  );
});

test("fallback rendering never throws for non-JSON-safe arguments", () => {
  const registry = new CodingToolPresentationRegistry();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assert.doesNotThrow(() => registry.render({
    type: "tool_start",
    call: { type: "toolCall", id: "c1", name: "unknown", arguments: cyclic },
  }));
  assert.match(registry.render({
    type: "tool_start",
    call: { type: "toolCall", id: "c2", name: "unknown", arguments: { value: 1n } },
  }), /unknown/);
});
