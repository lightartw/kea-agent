import { HookRegistry } from "../../agent/hooks/registry.js";
import { registerPermissionHook } from "./builtin/permission.js";
import type { CodingAgentInteractions } from "../ui/interactions.js";

export function createCodingHooks(
  interactions: CodingAgentInteractions,
): HookRegistry<CodingAgentInteractions> {
  const hooks = new HookRegistry(interactions);
  registerPermissionHook(hooks);
  return hooks;
}
