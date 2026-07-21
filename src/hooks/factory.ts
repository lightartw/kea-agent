import { PermissionHook } from "./builtin/permission.js";
import { HookRegistry } from "./registry.js";
import type { PermissionRequester } from "./types.js";

const denyWithoutInteraction: PermissionRequester = async () => false;

export function createHookRegistry(
  requestPermission: PermissionRequester = denyWithoutInteraction,
): HookRegistry {
  const registry = new HookRegistry({ requestPermission });
  registry.register(new PermissionHook());
  return registry;
}
