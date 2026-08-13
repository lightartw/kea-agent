import type { Static } from "typebox";
import { Type } from "typebox";

import {
  formatTodoContent,
  isTodoDetails,
  type TodoDetails,
  type TodoItem,
} from "./projection.js";
import type { CodingToolDefinition } from "../../definition.js";

export type { TodoDetails, TodoItem } from "./projection.js";

const parameters = Type.Object(
  {
    todos: Type.Array(
      Type.Object({
        content: Type.String(),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      }),
      { description: "The full task list. Include every task each time." },
    ),
  },
  { additionalProperties: false },
);

export function createTodoWriteToolDefinition(): CodingToolDefinition<typeof parameters, TodoDetails> {
  return {
    name: "todo_write",
    description: "Create and manage a task list for the current session. " +
      "Use this to plan your work before starting, track progress, " +
      "and keep one task in_progress at a time. Send the full list " +
      "each call — it replaces the previous one.",
    parameters,
    async execute(
      arguments_: Static<typeof parameters>,
      _signal: AbortSignal,
      _context,
    ): Promise<{ content: string; details: TodoDetails; isError: false }> {
      const todos: readonly TodoItem[] = arguments_.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
      }));
      return {
        content: formatTodoContent(todos),
        details: { todos },
        isError: false,
      };
    },
    presentation: {
      renderStart() {
        return undefined;
      },
      renderEnd(_call, result) {
        if (!isTodoDetails(result.details)) return undefined;
        return result.details.todos
          .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
          .join("\n");
      },
    },
  };
}
