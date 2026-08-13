export { createCodingAgent } from "./factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export {
  NO_INTERACTIONS,
} from "./ui/interactions.js";

export type {
  CodingAgentRuntime,
  CreateCodingAgentConfig,
} from "./types.js";
export type {
  CodingAgentInteractions,
  ConfirmationRequest,
  Notification,
} from "./ui/interactions.js";
export type {
  CodingToolPresentation,
  ToolPresentationCall,
  ToolPresentationRejected,
} from "./ui/presentation.js";
export type {
  CodingToolContext,
  CodingToolDefinition,
} from "./tools/definition.js";
export type {
  TodoItem,
  TodoDetails,
} from "./tools/builtin/todo.js";
