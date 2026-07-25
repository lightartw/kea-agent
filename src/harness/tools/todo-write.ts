import type { Static } from "typebox";
import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

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

export class TodoWriteTool extends AgentTool<typeof parameters> {
  constructor() {
    super(
      "todo_write",
      "Create and manage a task list for the current session. " +
        "Use this to plan your work before starting, track progress, " +
        "and keep one task in_progress at a time. Send the full list " +
        "each call — it replaces the previous one.",
      parameters,
    );
  }

  async execute(arguments_: Static<typeof parameters>, _signal: AbortSignal): Promise<AgentToolResult> {
    currentTodos = arguments_.todos;
    const lines = ["\n## Current Tasks"];
    for (const t of currentTodos) {
      const icon = TODO_ICONS[t.status] ?? " ";
      lines.push(`  [${icon}] ${t.content}`);
    }
    const formatted = lines.join("\n");
    return { content: `${formatted}\n\nUpdated ${currentTodos.length} tasks`, isError: false };
  }
}
