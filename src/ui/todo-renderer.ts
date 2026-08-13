import { isTodoDetails } from "../coding-agent/tools/todo-state.js";
import type { CliToolRenderer } from "./tool-renderers.js";

export function createTodoRenderer(): CliToolRenderer {
  return {
    renderStart() {
      return undefined;
    },
    renderEnd(_call, result) {
      if (!isTodoDetails(result.details)) return undefined;
      return result.details.todos
        .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
        .join("\n");
    },
  };
}
