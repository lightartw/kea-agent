import type { Static } from "typebox";
import { Type } from "typebox";

import type { ToolDefinition } from "../definition.js";

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface TodoDetails {
  readonly todos: readonly TodoItem[];
}

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

function formatTodos(todos: readonly TodoItem[]): string {
  return [
    "Current tasks:",
    ...todos.map((todo, index) =>
      `${index + 1}. [${todo.status}] ${todo.content}`),
    `Updated ${todos.length} tasks`,
  ].join("\n");
}

function isTodoDetails(value: unknown): value is TodoDetails {
  if (typeof value !== "object" || value === null) return false;
  const todos = (value as { todos?: unknown }).todos;
  return Array.isArray(todos) && todos.every((todo: unknown) => {
    if (typeof todo !== "object" || todo === null) return false;
    const item = todo as Record<string, unknown>;
    return typeof item.content === "string" &&
      (item.status === "pending" ||
        item.status === "in_progress" ||
        item.status === "completed");
  });
}

export function createTodoWriteToolDefinition(): ToolDefinition<
  typeof parameters,
  TodoDetails
> {
  return {
    name: "todo_write",
    description: "Create and manage a task list for the current session. " +
      "Use this to plan your work before starting, track progress, " +
      "and keep one task in_progress at a time. Send the full list " +
      "each call â€?it replaces the previous one.",
    parameters,
    async execute(arguments_: Static<typeof parameters>) {
      const todos: readonly TodoItem[] = arguments_.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
      }));
      return {
        content: formatTodos(todos),
        details: { todos },
        isError: false,
      };
    },
    presentation: {
      renderCall() {
        return undefined;
      },
      renderResult(_call, result) {
        if (!isTodoDetails(result.details)) return undefined;
        return result.details.todos
          .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
          .join("\n");
      },
    },
  };
}
