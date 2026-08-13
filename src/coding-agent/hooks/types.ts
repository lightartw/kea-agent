import { HookRegistry } from "../../agent/hooks/registry.js";
import type { CodingAgentInteractions } from "../ui/interactions/types.js";

/** Concrete Hook registry typed to the Coding Agent context. */
export type CodingHookRegistry = HookRegistry<CodingHookContext>;

/** Context passed to every Hook handler. */
export interface CodingHookContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}
