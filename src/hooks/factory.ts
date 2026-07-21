import { PermissionHook } from "./builtin/permission.js";
import { HookRegistry } from "./registry.js";
import type { PermissionRequester } from "./types.js";

const denyWithoutInteraction: PermissionRequester = async () => false;

/** Create the built-in hook set; headless callers fail closed by default. */
export function createHookRegistry(
  requestPermission: PermissionRequester = denyWithoutInteraction,
): HookRegistry {
  const registry = new HookRegistry({ requestPermission });
  registry.register(new PermissionHook());
  return registry;
}
