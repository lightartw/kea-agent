import type { Message } from "../../llm-client/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

/**
 * Hook lifecycle:
 *   1. user_prompt_submit → Agent.prompt()
 *   2. pre_tool_use       → ToolRegistry.execute()
 *   3. post_tool_use      → ToolRegistry.execute()
 *   4. stop               → agent-loop.ts: runAgentTurn()
 *
 * trigger_hooks runs hooks in order, stops at the first non-undefined result.
 */

/** Shared discriminator understood by the hook registry. */
export interface HookEvent {
  readonly type: string;
}

/** 1. user_prompt_submit — Agent.prompt() */
export interface UserPromptSubmitEvent extends HookEvent {
  readonly type: "user_prompt_submit";
  readonly prompt: string;
}

/** 2. pre_tool_use — ToolRegistry.execute() */
export interface PreToolUseEvent extends HookEvent {
  readonly type: "pre_tool_use";
  readonly call: ToolCall;
}

/** 3. post_tool_use — ToolRegistry.execute() */
export interface PostToolUseEvent extends HookEvent {
  readonly type: "post_tool_use";
  readonly call: ToolCall;
  readonly result: ToolResult;
}

/** 4. stop — agent-loop.ts: runAgentTurn() */
export interface StopEvent extends HookEvent {
  readonly type: "stop";
  readonly messages: readonly Message[];
}

/** Union of every lifecycle event a hook can subscribe to. */
export type HookEventUnion =
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | StopEvent;

/**
 * First non-undefined return from a hook stops the chain.
 * Fields by lifecycle:
 *   user_prompt_submit → { block, reason } | { context }
 *   pre_tool_use      → { block, reason }
 *   post_tool_use     → (usually void — side-effect only)
 *   stop              → { messages } | { forceContinue }
 */
export interface HookResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly messages?: readonly Message[];
  readonly context?: string;
  /** Stop only: inject this as a user message and continue the loop. */
  readonly forceContinue?: string;
}

/** Return undefined to continue the chain. */
export interface Hook<TEvent extends HookEvent = HookEvent> {
  readonly name: string;
  readonly eventType: TEvent["type"];
  execute(event: TEvent): HookResult | void | Promise<HookResult | void>;
}
