export { createHarness } from "./factory.js";
export { createCodingHookRegistry } from "./hooks/factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export { createToolRegistry } from "./tools/factory.js";
export {
  NO_INTERACTIONS,
} from "./ui/interactions.js";
export {
  CodingToolPresentationRegistry,
} from "./ui/presentation-registry.js";

export type { CreateHarnessConfig } from "./types.js";
export type { CodingHookContext } from "./hooks/types.js";
export type {
  CodingAgentInteractions,
  ConfirmationRequest,
  Notification,
} from "./ui/interactions.js";
export type {
  CodingToolPresentation,
  ToolPresentationCall,
  ToolPresentationRejected,
} from "./ui/tool-presentation.js";
export type {
  TodoItem,
  TodoDetails,
} from "./tools/todo-state.js";
