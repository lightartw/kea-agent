import { HookRegistry } from "../../agent/hooks/registry.js";
import type { Hook } from "../../agent/hooks/types.js";
import { PermissionHook } from "./permission.js";

const BUILTIN_HOOKS: readonly Hook[] = [
  new PermissionHook(),
];

/**
 * Build the default hook pipeline for one workspace.
 * Built-in hooks are registered internally; callers can optionally supply
 * additional hooks. Mirrors createToolRegistry.
 */
export function createHookRegistry(
  hooks?: Iterable<Hook>,
): HookRegistry {
  const registry = new HookRegistry();
  for (const hook of BUILTIN_HOOKS) registry.register(hook);
  if (hooks !== undefined) {
    for (const hook of hooks) registry.register(hook);
  }
  return registry;
}
