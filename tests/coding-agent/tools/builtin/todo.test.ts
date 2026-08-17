import assert from "node:assert/strict";
import test from "node:test";

import { createTodoWriteTool } from "../../../../src/coding-agent/tools/builtin/todo.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("todo_write exposes its name, description, and exact schema", () => {
  const tool = createTodoWriteTool();
  assert.equal(tool.name, "todo_write");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.length > 0);
  assert.equal(
    tool.validate({ todos: [{ content: "Task", status: "pending" }] }),
    undefined,
  );
  assert.ok(tool.validate({}));
});

test("todo_write returns the complete list in content and details", async () => {
  const tool = createTodoWriteTool();
  const result = await tool.execute({ todos: [
    { content: "Read code", status: "completed" },
    { content: "Design UI", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ] }, signal());

  assert.equal(result.isError, false);
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
  const tool = createTodoWriteTool();
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

test("todo_write formats an empty list", async () => {
  const result = await createTodoWriteTool().execute({ todos: [] }, signal());
  assert.equal(result.content, "Current tasks:\nUpdated 0 tasks");
  assert.deepEqual(result.details, { todos: [] });
});

test("todo_write copies input items instead of sharing them", async () => {
  const tool = createTodoWriteTool();
  const input = {
    todos: [
      { content: "Read code", status: "completed" as const },
      { content: "Add tests", status: "pending" as const },
    ],
  };
  const result = await tool.execute(input, signal());
  input.todos[0] = { content: "mutated", status: "pending" as const };
  assert.deepEqual(result.details, {
    todos: [
      { content: "Read code", status: "completed" },
      { content: "Add tests", status: "pending" },
    ],
  });
});

test("todo_write accepts every valid status", () => {
  const tool = createTodoWriteTool();
  for (const status of ["pending", "in_progress", "completed"]) {
    assert.equal(
      tool.validate({ todos: [{ content: "Task", status }] }),
      undefined,
      status,
    );
  }
});

test("todo_write rejects extra properties", () => {
  const tool = createTodoWriteTool();
  assert.ok(tool.validate({ todos: [{ content: "Task", status: "pending", extra: 1 }] }));
  assert.ok(tool.validate({ todos: [{ content: "Task", status: "pending" }], extra: 1 }));
});

test("todo_write rejects empty content and invalid statuses", () => {
  const tool = createTodoWriteTool();
  assert.ok(tool.validate({ todos: [{ content: "", status: "pending" }] }));
  assert.ok(tool.validate({ todos: [{ content: "Task", status: "done" }] }));
});

test("todo_write rejects more than 50 items", () => {
  const tool = createTodoWriteTool();
  const todos = Array.from({ length: 51 }, () => ({ content: "Task", status: "pending" }));
  assert.ok(tool.validate({ todos }));
});

test("todo_write rejects content longer than 200 characters", () => {
  const tool = createTodoWriteTool();
  assert.ok(tool.validate({
    todos: [{ content: "x".repeat(201), status: "pending" }],
  }));
  assert.equal(tool.validate({
    todos: [{ content: "x".repeat(200), status: "pending" }],
  }), undefined);
});
