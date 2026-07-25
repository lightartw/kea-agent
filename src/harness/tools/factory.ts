import { AgentToolRegistry } from "../../agent/tools/registry.js";
import { BashTool } from "./bash.js";
import { ReadFileTool, WriteFileTool, EditFileTool } from "./files.js";
import { GlobTool } from "./glob.js";
import { TodoWriteTool } from "./todo-write.js";

/** Build the default tool set for one workspace. */
export function createToolRegistry(cwd: string): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(new BashTool(cwd));
  registry.register(new ReadFileTool(cwd));
  registry.register(new WriteFileTool(cwd));
  registry.register(new EditFileTool(cwd));
  registry.register(new GlobTool(cwd));
  registry.register(new TodoWriteTool());
  return registry;
}
