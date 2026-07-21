import { BashTool } from "./builtin/bash.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./builtin/files.js";
import { GlobTool } from "./builtin/glob.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

const BUILTIN_TOOLS: readonly {
  readonly name: string;
  readonly create: (workspace: string) => Tool;
}[] = [
  { name: "bash", create: (workspace) => new BashTool(workspace) },
  { name: "read_file", create: (workspace) => new ReadFileTool(workspace) },
  { name: "write_file", create: (workspace) => new WriteFileTool(workspace) },
  { name: "edit_file", create: (workspace) => new EditFileTool(workspace) },
  { name: "glob", create: (workspace) => new GlobTool(workspace) },
];

export function createToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry();
  for (const { create } of BUILTIN_TOOLS) registry.register(create(cwd));
  return registry;
}
