export { createCodingAgent } from "./factory.js";
export { createDefaultCodingHookRegistry } from "./hooks/builtin/factory.js";
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
} from "./ui/presentation-registry.js";

export type { CodingAgentRuntime } from "./runtime.js";
export type { CreateCodingAgentConfig } from "./types.js";
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
  CodingToolContext,
  CodingToolDefinition,
} from "./tools/definition.js";
export type {
  TodoItem,
  TodoDetails,
} from "./tools/builtin/todo/projection.js";
