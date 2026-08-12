import { HookRegistry } from "../../agent/hooks/registry.js";
import type { CodingHookContext, CodingHookUI } from "../types.js";

/** Concrete Hook registry typed to the Coding Agent context. */
export type CodingHookRegistry = HookRegistry<CodingHookContext>;

/** Fallback UI that is always available but denies everything and discards notifications. */
export const NO_UI: CodingHookUI = Object.freeze({
  available: false,
  async confirm() {
    return false;
  },
  notify() {
    return undefined;
  },
});
