export { createHarness } from "./factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
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

export type { CreateHarnessConfig } from "../agent/harness/types.js";
export type { BashOperations } from "./tools/bash.js";
export type { TodoItem } from "./tools/todo-write.js";
