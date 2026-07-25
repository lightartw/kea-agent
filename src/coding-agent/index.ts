export { AgentHarness } from "../agent/harness/agent-harness.js";
export { createHarness } from "./factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export {
  defaultSystemPrompt,
  formatSystemPrompt,
} from "../agent/harness/system-prompt.js";
export { Session } from "../agent/harness/session/session.js";
export { SessionError } from "../agent/harness/session/types.js";
export { SessionManager } from "../agent/harness/session/manager.js";
export { createToolRegistry } from "./tools/factory.js";
export { BashTool } from "./tools/bash.js";
export { LocalBashOperations } from "./tools/bash-ops.js";
export {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
} from "./tools/files.js";
export { GlobTool } from "./tools/glob.js";
export { TodoWriteTool } from "./tools/todo-write.js";

export type {
  CreateHarnessConfig,
  HarnessConfig,
  HarnessEventListener,
  HarnessProject,
  SystemPromptBuilder,
  SystemPromptContext,
  Unsubscribe,
} from "../agent/harness/types.js";
export type {
  SessionContext,
  SessionErrorCode,
} from "../agent/harness/session/types.js";
export type { BashOperations } from "./tools/bash.js";
export type { TodoItem } from "./tools/todo-write.js";
