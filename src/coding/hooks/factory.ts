import { HookRegistry } from "../../agent/hooks/registry.js";
import type { Hook } from "../../agent/hooks/types.js";
import { PermissionHook } from "./permission.js";

/** Build a registry from any number of independently configured hooks. */
export function createHookRegistry(
  hooks: Iterable<Hook> = [],
): HookRegistry {
  const registry = new HookRegistry();
  for (const hook of hooks) registry.register(hook);
  return registry;
}

/**
 * Build the default hook pipeline for the coding agent.
 * Mirror of createToolRegistry: zero special parameters, auto-registers
 * built-in hooks. Callers configure individual hooks post-creation via
 * HookRegistry.get().
 *
 * Adding a new built-in hook is a one-line change here — main.ts stays
 * unchanged regardless of how many hooks exist or what they need.
 */
export function createDefaultHooks(): HookRegistry {
  return createHookRegistry([
    new PermissionHook(),
    // Future built-in hooks register here.
  ]);
}
