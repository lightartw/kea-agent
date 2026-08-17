import { AgentToolRegistry } from "../../core/agent/tools/registry.js";
import { createBashTool } from "./builtin/bash/bash.js";
import { createEditFileTool } from "./builtin/edit-file.js";
import { createGlobTool } from "./builtin/glob.js";
import { createReadFileTool } from "./builtin/read-file.js";
import { createTodoWriteTool } from "./builtin/todo.js";
import { createWriteFileTool } from "./builtin/write-file.js";

/**
 * The standard tool set for a coding agent session, all resolving paths
 * relative to the given cwd. Each call builds fresh, independent tools.
 */
export function createBuiltinToolRegistry(cwd: string): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(createBashTool(cwd));
  registry.register(createReadFileTool(cwd));
  registry.register(createWriteFileTool(cwd));
  registry.register(createEditFileTool(cwd));
  registry.register(createGlobTool(cwd));
  registry.register(createTodoWriteTool());
  return registry;
}
