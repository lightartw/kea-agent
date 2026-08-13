export { createHarness } from "./factory.js";
export { createCodingHookRegistry } from "./hooks/factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export { createToolRegistry } from "./tools/factory.js";

export type { CreateHarnessConfig } from "./types.js";
export type {
  CodingHookContext,
  CodingHookUI,
  HookConfirmation,
  HookNotification,
} from "./types.js";
export type {
  TodoItem,
  TodoDetails,
} from "./tools/todo-state.js";
