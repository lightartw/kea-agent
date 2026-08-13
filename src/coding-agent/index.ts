export { createCodingAgent } from "./factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export { createDefaultToolDefinitions } from "./tools/builtin/factory.js";
export { toAgentTool } from "./tools/wrapper.js";
export {
  NO_INTERACTIONS,
} from "./ui/interactions.js";
export {
  CodingToolPresentationRegistry,
} from "./ui/presentation/registry.js";

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
} from "./ui/presentation/types.js";
export type {
  CodingToolContext,
  CodingToolDefinition,
} from "./tools/definition.js";
export type {
  TodoItem,
  TodoDetails,
} from "./tools/builtin/todo/projection.js";
