import { HookRegistry } from "../../agent/hooks/registry.js";

/** Concrete Hook registry typed to the Coding Agent context. */
export type CodingHookRegistry = HookRegistry<CodingHookContext>;

/** A structured confirmation a Hook asks the user to approve or reject. */
export interface HookConfirmation {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

/** A structured notification a Hook produces for its own purpose. */
export interface HookNotification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

/**
 * Narrow UI port that coding-agent defines; CLI or any frontend implements it.
 * Coding-agent never imports CLI or frontend code.
 */
export interface CodingHookUI {
  readonly available: boolean;
  confirm(
    confirmation: HookConfirmation,
    signal?: AbortSignal,
  ): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}

/** Context passed to every Hook handler. */
export interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}

/** Fallback UI that is always available but denies everything and discards notifications. */
export const NO_HOOK_UI: CodingHookUI = Object.freeze({
  available: false,
  async confirm() {
    return false;
  },
  notify() {
    return undefined;
  },
});
