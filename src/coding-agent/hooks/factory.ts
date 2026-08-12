import { HookRegistry } from "../../agent/hooks/registry.js";
import type { CodingHookContext } from "../types.js";
import { registerContextInjectHook } from "./context-inject.js";
import { registerLogHook } from "./log.js";
import { registerLargeOutputHook } from "./large-output.js";
import { registerPermissionHook } from "./permission.js";
import { registerSummaryHook } from "./summary.js";
import type { CodingHookRegistry } from "./types.js";

/**
 * Create a Hook registry pre-configured with the five default
 * Coding Agent hooks. Listener execution is always before control
 * handlers regardless of registration order.
 */
export function createCodingHookRegistry(
  context: CodingHookContext,
): CodingHookRegistry {
  const registry =
    new HookRegistry<CodingHookContext>(context);
  registerContextInjectHook(registry);
  registerLogHook(registry);
  registerLargeOutputHook(registry);
  registerPermissionHook(registry);
  registerSummaryHook(registry);
  return registry;
}
