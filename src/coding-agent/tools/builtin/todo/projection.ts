import type { AgentMessage } from "../../../../agent/types.js";

export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface TodoDetails {
  readonly todos: readonly TodoItem[];
}

export function formatTodoContent(todos: readonly TodoItem[]): string {
  return [
    "Current tasks:",
    ...todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`),
    `Updated ${todos.length} tasks`,
  ].join("\n");
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.content === "string" &&
    (item.status === "pending" || item.status === "in_progress" || item.status === "completed");
}

export function isTodoDetails(value: unknown): value is TodoDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return Array.isArray(details.todos) && details.todos.every(isTodoItem);
}

export function findLatestTodoDetails(
  messages: readonly AgentMessage[],
): TodoDetails | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "tool" && message.name === "todo_write" &&
      isTodoDetails(message.details)) {
      return message.details;
    }
  }
  return undefined;
}
