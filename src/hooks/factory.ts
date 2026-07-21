import { HookRegistry } from "./registry.js";
import type { Hook } from "./types.js";

/** Build one registry from any number of independently configured hooks. */
export function createHookRegistry(
  hooks: Iterable<Hook> = [],
): HookRegistry {
  const registry = new HookRegistry();
  for (const hook of hooks) registry.register(hook);
  return registry;
}
