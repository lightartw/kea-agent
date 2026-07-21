import type { ToolCall } from "../tools/types.js";

/** Information a presentation layer needs to ask for one approval. */
export interface PermissionRequest {
  readonly call: ToolCall;
  readonly reason: string;
}

export type PermissionRequester = (
  request: PermissionRequest,
) => Promise<boolean>;

/** Capabilities supplied by the host without coupling hooks to CLI or TUI code. */
export interface HookContext {
  readonly requestPermission: PermissionRequester;
}

export interface PreToolUseEvent {
  readonly type: "pre_tool_use";
  readonly call: ToolCall;
}

export type HookEvent = PreToolUseEvent;

/** Returning a block result short-circuits the remaining hooks and the tool. */
export interface HookBlockResult {
  readonly block: true;
  readonly reason: string;
}

export type HookResult = HookBlockResult | undefined;

/** A lifecycle hook runs cross-cutting behavior without growing the agent loop. */
export abstract class Hook<TEvent extends HookEvent = HookEvent> {
  protected constructor(
    readonly name: string,
    readonly eventType: TEvent["type"],
  ) {}

  abstract execute(event: TEvent, context: HookContext): Promise<HookResult>;
}
