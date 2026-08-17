import { Type } from "typebox";

import { AgentTool } from "../../../core/agent/tools/types.js";

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface TodoDetails {
  readonly todos: readonly TodoItem[];
}

const todoItemParameters = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 200 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
}, { additionalProperties: false });

const parameters = Type.Object({
  todos: Type.Array(todoItemParameters, {
    maxItems: 50,
    description: "The full task list. Include every task each time.",
  }),
}, { additionalProperties: false });

/** Render the numbered list the same way it is sent to the model. */
function formatTodos(todos: readonly TodoItem[]): string {
  return [
    "Current tasks:",
    ...todos.map((todo, index) =>
      `${index + 1}. [${todo.status}] ${todo.content}`),
    `Updated ${todos.length} tasks`,
  ].join("\n");
}

class TodoWriteTool extends AgentTool<typeof parameters, TodoDetails> {
  constructor() {
    super("todo_write", "Replace the current complete task list.", parameters);
  }

  async execute(
    arguments_: { todos: readonly TodoItem[] },
    _signal: AbortSignal,
  ): Promise<{
    content: string;
    details: TodoDetails;
    isError: boolean;
  }> {
    // Copy every item so later mutation of the caller's input cannot leak in.
    const todos: readonly TodoItem[] = arguments_.todos.map((todo) => ({
      content: todo.content,
      status: todo.status,
    }));
    return {
      content: formatTodos(todos),
      details: { todos },
      isError: false,
    };
  }
}

/** Create the built-in todo tool, which keeps no state between calls. */
export function createTodoWriteTool(): AgentTool<typeof parameters, TodoDetails> {
  return new TodoWriteTool();
}
