export { AgentHarness } from "./agent-harness.js";
export { createHarness } from "./factory.js";
export type {
  CreateHarnessConfig,
  HarnessConfig,
  HarnessEventListener,
  HarnessProject,
  SystemPromptBuilder,
  SystemPromptContext,
  Unsubscribe,
} from "./types.js";
export { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
export { defaultSystemPrompt, formatSystemPrompt } from "./system-prompt.js";
export { Session } from "./session/session.js";
export { createToolRegistry } from "./tools/factory.js";
// Hook exports retained until Task 4 removes the subsystem
export { createHookRegistry } from "./hooks/factory.js";
export { PermissionHook } from "./hooks/permission.js";
