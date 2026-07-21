/**
 * todo_write tool — planning only, no filesystem side effects.
 *
 * Related code (reminder mechanism via hooks, not agent-loop):
 *   hooks/todo-reminder.ts   — 3 hooks sharing a roundsSinceTodo counter
 *   hooks/factory.ts         — registers the 3 hooks
 *   agent/hooks/types.ts     — PreTurnEvent (fires before each LLM call)
 *   agent/agent-loop.ts      — triggers pre_turn hook
 *   tools/factory.ts         — registers this tool in BUILTIN_FACTORIES
 */

import type { Static } from "typebox";
import { Type } from "typebox";

import type { ToolDefinition } from "./types.js";

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/** In-process task list shared across the session. */
let currentTodos: readonly TodoItem[] = [];

export function getCurrentTodos(): readonly TodoItem[] {
  return currentTodos;
}

const TODO_ICONS: Record<TodoItem["status"], string> = {
  pending: " ",
  in_progress: "▸",
  completed: "✓",
};

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

export function createTodoWriteDefinition(): ToolDefinition<
  typeof parameters
> {
  return {
    name: "todo_write",
    description:
      "Create and manage a task list for the current session. " +
      "Use this to plan your work before starting, track progress, " +
      "and keep one task in_progress at a time. Send the full list " +
      "each call — it replaces the previous one.",
    parameters,
    async execute(arguments_: Static<typeof parameters>) {
      currentTodos = arguments_.todos;
      const lines = ["\n## Current Tasks"];
      for (const t of currentTodos) {
        const icon = TODO_ICONS[t.status] ?? " ";
        lines.push(`  [${icon}] ${t.content}`);
      }
      const formatted = lines.join("\n");
      return `${formatted}\n\nUpdated ${currentTodos.length} tasks`;
    },
  };
}
