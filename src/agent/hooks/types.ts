import type { ToolCall } from "../tools/types.js";

/** Shared discriminator understood by the hook registry. */
export interface HookEvent {
  readonly type: string;
}

/** Event emitted after tool arguments pass validation but before execution. */
export interface PreToolUseEvent extends HookEvent {
  readonly type: "pre_tool_use";
  readonly call: ToolCall;
}

/** Returning a block result short-circuits the remaining hooks and the tool. */
export type HookResult =
  | { readonly block: true; readonly reason: string }
  | undefined;

/** Common interface; concrete hooks specialize it with one lifecycle event. */
export interface Hook<TEvent extends HookEvent = HookEvent> {
  readonly name: string;
  readonly eventType: TEvent["type"];
  execute(event: TEvent): Promise<HookResult>;
}
