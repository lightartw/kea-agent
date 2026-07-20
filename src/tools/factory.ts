import { BashTool } from "./builtin/bash.js";
import { ToolRegistry } from "./registry.js";

export function createToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new BashTool({ cwd }));
  return registry;
}
