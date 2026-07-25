import assert from "node:assert/strict";
import test from "node:test";

import {
  TodoWriteTool,
  type TodoItem,
} from "../../../src/coding-agent/tools/todo-write.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

type InspectableTodoTool = {
  readonly todos: readonly TodoItem[];
};

test("todo state belongs to each tool instance", async () => {
  const first = new TodoWriteTool();
  const second = new TodoWriteTool();

  await first.execute(
    { todos: [{ content: "first", status: "in_progress" }] },
    signal(),
  );

  assert.deepEqual(
    (first as unknown as InspectableTodoTool).todos,
    [{ content: "first", status: "in_progress" }],
  );
  assert.deepEqual((second as unknown as InspectableTodoTool).todos, []);
});
