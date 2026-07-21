import type { ToolCall } from "../tools/types.js";

/** Returning a block result short-circuits the remaining hooks and the tool. */
export type HookResult =
  | { readonly block: true; readonly reason: string }
  | undefined;

/** Cross-cutting behavior run immediately before one validated tool call. */
export interface PreToolUseHook {
  readonly name: string;
  execute(call: ToolCall): Promise<HookResult>;
}
