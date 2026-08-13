import assert from "node:assert/strict";
import test from "node:test";

import { createTodoRenderer } from "../../src/ui/todo-renderer.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";

const call: AgentToolCall = {
  type: "toolCall", id: "c1", name: "todo_write", arguments: {},
};

test("todo renderer renders validated details as one line per item", () => {
  const renderer = createTodoRenderer();
  const result = {
    content: "Current tasks:\n1. [completed] A\nUpdated 1 tasks",
    details: { todos: [{ content: "A", status: "completed" }] },
    isError: false,
  };
  assert.equal(renderer.renderEnd(call, result), "1. [completed] A");
});

test("todo renderer returns undefined for missing or malformed details", () => {
  const renderer = createTodoRenderer();
  assert.equal(
    renderer.renderEnd(call, { content: "no details", isError: false }),
    undefined,
  );
  assert.equal(
    renderer.renderEnd(call, { content: "bad", details: { wrong: true }, isError: false }),
    undefined,
  );
});
