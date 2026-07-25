import type { Static } from "typebox";
import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
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
  private todos: readonly TodoItem[] = [];

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
    this.todos = arguments_.todos;
    const lines = ["\n## Current Tasks"];
    for (const todo of this.todos) {
      const icon = TODO_ICONS[todo.status] ?? " ";
      lines.push(`  [${icon}] ${todo.content}`);
    }
    const formatted = lines.join("\n");
    return {
      content: `${formatted}\n\nUpdated ${this.todos.length} tasks`,
      isError: false,
    };
  }
}
