import type { HookRegistry } from "../hooks/registry.js";
import { BashTool } from "./builtin/bash.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./builtin/files.js";
import { GlobTool } from "./builtin/glob.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

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
