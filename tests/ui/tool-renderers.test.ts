import assert from "node:assert/strict";
import test from "node:test";

import { CliToolRendererRegistry } from "../../src/ui/tool-renderers.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";
import type { ToolRejectedEvent } from "../../src/agent/types.js";

const todoCall: AgentToolCall = {
  type: "toolCall", id: "c1", name: "todo_write", arguments: {},
};
const unknownCall: AgentToolCall = {
  type: "toolCall", id: "c2", name: "unknown", arguments: {},
};
const okResult = { content: "ok", isError: false };
const rejectedEvent: ToolRejectedEvent = {
  type: "tool_rejected",
  call: todoCall,
  result: { content: "Error: no", isError: true },
  reason: "blocked",
};

test("registry matches by tool name and falls back for unknown tools", () => {
  const errors: string[] = [];
  const registry = new CliToolRendererRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderStart: () => "todo start",
    renderEnd: () => "todo end",
    renderRejected: () => "todo rejected",
  });

  assert.equal(registry.renderStart(todoCall), "todo start");
  assert.equal(registry.renderEnd(todoCall, okResult), "todo end");
  assert.equal(registry.renderRejected(rejectedEvent), "todo rejected");
  assert.match(registry.renderStart(unknownCall), /unknown/);
});

test("registry falls back when a renderer returns undefined or throws", () => {
  const errors: string[] = [];
  const registry = new CliToolRendererRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderStart: () => undefined,
    renderEnd: () => { throw new Error("boom"); },
  });

  assert.equal(registry.renderStart(todoCall), "[exec] todo_write: {}");
  assert.equal(registry.renderEnd(todoCall, okResult), "[done] todo_write: ok");
  assert.deepEqual(errors, ["boom"]);
});

test("registry reports one error per thrown method and falls back", () => {
  const errors: string[] = [];
  const registry = new CliToolRendererRegistry((message) => errors.push(message));
  registry.register("todo_write", {
    renderStart: () => { throw new Error("start fail"); },
    renderEnd: () => { throw new Error("end fail"); },
    renderRejected: () => { throw new Error("reject fail"); },
  });

  assert.match(registry.renderStart(todoCall), /\[exec\]/);
  assert.match(registry.renderEnd(todoCall, okResult), /\[done\]/);
  assert.match(registry.renderRejected(rejectedEvent), /\[rejected:blocked\]/);
  assert.deepEqual(errors, ["start fail", "end fail", "reject fail"]);
});

test("duplicate registration throws", () => {
  const registry = new CliToolRendererRegistry(() => undefined);
  registry.register("todo_write", { renderStart: () => "x", renderEnd: () => "y" });
  assert.throws(
    () => registry.register("todo_write", { renderStart: () => "z", renderEnd: () => "w" }),
    /already registered/,
  );
});
