import assert from "node:assert/strict";
import test from "node:test";

import { TodoWriteTool } from "../../../src/coding-agent/tools/todo-write.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("todo_write returns the complete list in content and details", async () => {
  const tool = new TodoWriteTool();
  const result = await tool.execute({ todos: [
    { content: "Read code", status: "completed" },
    { content: "Design UI", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ] }, signal());

  assert.equal(result.content, [
    "Current tasks:",
    "1. [completed] Read code",
    "2. [in_progress] Design UI",
    "3. [pending] Add tests",
    "Updated 3 tasks",
  ].join("\n"));
  assert.deepEqual(result.details, { todos: [
    { content: "Read code", status: "completed" },
    { content: "Design UI", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ] });
});

test("todo_write second call depends only on the second full input", async () => {
  const tool = new TodoWriteTool();
  await tool.execute({ todos: [
    { content: "first", status: "completed" },
  ] }, signal());

  const second = await tool.execute({ todos: [
    { content: "second", status: "pending" },
  ] }, signal());

  assert.equal(second.content, [
    "Current tasks:",
    "1. [pending] second",
    "Updated 1 tasks",
  ].join("\n"));
  assert.deepEqual(second.details, { todos: [
    { content: "second", status: "pending" },
  ] });
});
