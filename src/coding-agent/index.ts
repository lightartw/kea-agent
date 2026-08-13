export { createProject } from "./factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export {
  NO_INTERACTIONS,
} from "./ui/interactions.js";
export {
  CodingToolPresentationRegistry,
} from "./ui/presentation.js";
export {
  openOrCreateProject,
  persistProject,
  applyProjectUpdate,
  assertDirectoryOwnership,
} from "./project/storage.js";

export type {
  Project,
  ProjectInfo,
  OpenedProject,
  OpenProjectInput,
  UpdateProjectInput,
  CreateSessionOptions,
} from "./project/types.js";
export type { CreateProjectConfig } from "./types.js";
export type {
  CodingAgentInteractions,
  ConfirmationRequest,
  Notification,
} from "./ui/interactions.js";
export type {
  CodingToolPresentation,
  ToolPresentationCall,
  ToolPresentationInput,
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
