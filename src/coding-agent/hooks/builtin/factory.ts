import { HookRegistry } from "../../../agent/hooks/registry.js";
import type { CodingHookContext } from "../types.js";
import { registerPermissionHook } from "./permission.js";
import type { CodingHookRegistry } from "../types.js";

/**
 * Create a Hook registry pre-configured with the single control Hook that
 * actually changes control flow: permission. Passive display lives in UI
 * subscribe consumers, not here.
 */
export function createDefaultCodingHookRegistry(
  context: CodingHookContext,
): CodingHookRegistry {
  const registry =
    new HookRegistry<CodingHookContext>(context);
  registerPermissionHook(registry);
  return registry;
}
