import type { HookRegistry } from "../../agent/hooks/registry.js";
import { BashTool } from "./bash.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./files.js";
import { GlobTool } from "./glob.js";
import { ToolRegistry } from "../../agent/tools/registry.js";
import type { Tool } from "../../agent/tools/types.js";

const BUILTIN_TOOLS: readonly ((workspace: string) => Tool)[] = [
  (workspace) => new BashTool(workspace),
  (workspace) => new ReadFileTool(workspace),
  (workspace) => new WriteFileTool(workspace),
  (workspace) => new EditFileTool(workspace),
  (workspace) => new GlobTool(workspace),
];

/** Build the explicit default tool set for one workspace and hook pipeline. */
export function createToolRegistry(
  cwd = process.cwd(),
  hooks?: HookRegistry,
): ToolRegistry {
  const registry = new ToolRegistry(120, hooks);
  for (const create of BUILTIN_TOOLS) registry.register(create(cwd));
  return registry;
}
