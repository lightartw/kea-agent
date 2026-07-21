import type { ToolCall } from "../tools/types.js";

export interface PermissionRequest {
  readonly call: ToolCall;
  readonly reason: string;
}

export type PermissionRequester = (
  request: PermissionRequest,
) => Promise<boolean>;

export interface HookContext {
  readonly requestPermission: PermissionRequester;
}

export interface PreToolUseEvent {
  readonly type: "pre_tool_use";
  readonly call: ToolCall;
}

export type HookEvent = PreToolUseEvent;

export interface HookBlockResult {
  readonly block: true;
  readonly reason: string;
}

export type HookResult = HookBlockResult | undefined;

/** A lifecycle hook runs cross-cutting behavior around the agent core. */
export abstract class Hook<TEvent extends HookEvent = HookEvent> {
  protected constructor(
    readonly name: string,
    readonly eventType: TEvent["type"],
  ) {}

  abstract execute(event: TEvent, context: HookContext): Promise<HookResult>;
}
