import type { HookRegistry } from "../../agent/hooks/registry.js";
import type { Tool } from "../../agent/tools/types.js";
import { ToolRegistry } from "../../agent/tools/registry.js";
import { wrapToolDefinition } from "./adapter.js";
import { createBashToolDefinition } from "./bash.js";
import {
  createEditFileDefinition,
  createReadFileDefinition,
  createWriteFileDefinition,
} from "./files.js";
import { createGlobDefinition } from "./glob.js";

type ToolFactory = (workspace: string) => Tool;

const BUILTIN_FACTORIES: readonly ToolFactory[] = [
  (workspace) => wrapToolDefinition(createBashToolDefinition(workspace)),
  (workspace) => wrapToolDefinition(createReadFileDefinition(workspace)),
  (workspace) => wrapToolDefinition(createWriteFileDefinition(workspace)),
  (workspace) => wrapToolDefinition(createEditFileDefinition(workspace)),
  (workspace) => wrapToolDefinition(createGlobDefinition(workspace)),
];

/** Build the explicit default tool set for one workspace and hook pipeline. */
export function createToolRegistry(
  cwd = process.cwd(),
  hooks?: HookRegistry,
): ToolRegistry {
  const registry = new ToolRegistry(120, hooks);
  for (const create of BUILTIN_FACTORIES) registry.register(create(cwd));
  return registry;
}
