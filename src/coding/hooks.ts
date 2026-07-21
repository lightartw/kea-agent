import { createHookRegistry } from "../agent/hooks/factory.js";
import type { HookRegistry } from "../agent/hooks/registry.js";
import { PermissionHook, type PermissionRequester } from "./permission.js";

/**
 * Build the default hook pipeline for the coding agent.
 * Mirror of createToolRegistry: main.ts only calls this factory and never
 * constructs individual hooks. Adding a new built-in hook is one line here.
 */
export function createDefaultHooks(
  requestPermission: PermissionRequester,
): HookRegistry {
  return createHookRegistry([
    new PermissionHook(requestPermission),
    // Future built-in hooks (e.g. telemetry, rate-limit, sandbox audit)
    // register here — main.ts stays unchanged.
  ]);
}
