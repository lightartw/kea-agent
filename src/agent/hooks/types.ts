import type { Message, ToolCall } from "../../ai/types.js";
import type { ToolResult } from "../tools/types.js";

/**
 * Hook lifecycle — all hooks run inside runAgentLoop():
 *   1. user_prompt_submit → before pushing user message
 *   2. pre_turn           → before LLM stream
 *   3. pre_tool_use       → before each tool execution
 *   4. post_tool_use      → after each tool execution (side-effect, failures swallowed)
 *   5. stop               → after assistant message with no tool calls
 */

/** Shared discriminator understood by the hook registry. */
export interface HookEvent {
  readonly type: string;
}

/** 1. user_prompt_submit — before pushing user message */
export interface UserPromptSubmitEvent extends HookEvent {
  readonly type: "user_prompt_submit";
  readonly prompt: string;
}

/** 2. pre_turn — before LLM stream */
export interface PreTurnEvent extends HookEvent {
  readonly type: "pre_turn";
}

/** 3. pre_tool_use — before each tool execution */
export interface PreToolUseEvent extends HookEvent {
  readonly type: "pre_tool_use";
  readonly call: ToolCall;
}

/** 4. post_tool_use — after each tool execution, side-effect only */
export interface PostToolUseEvent extends HookEvent {
  readonly type: "post_tool_use";
  readonly call: ToolCall;
  readonly result: ToolResult;
}

/** 5. stop — after assistant message with no tool calls */
export interface StopEvent extends HookEvent {
  readonly type: "stop";
  readonly messages: readonly Message[];
}

/** Union of every lifecycle event a hook can subscribe to. */
export type HookEventUnion =
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PreTurnEvent
  | StopEvent;

/**
 * First non-undefined return from a hook stops the chain.
 * Fields by lifecycle:
 *   user_prompt_submit → { block, reason }
 *   pre_turn           → { context }  (injected as user message before LLM call)
 *   pre_tool_use       → { block, reason }
 *   post_tool_use      → (usually void — side-effect only)
 *   stop               → { messages } | { forceContinue }
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
