import type { Message, ToolCall } from "../../ai/types.js";
import type { AgentToolResult } from "../../agent/tools/types.js";

/**
 * Hook lifecycle — all hooks run inside the agent loop via AgentLoopConfig:
 *   1. user_prompt_submit → onUserPrompt
 *   2. pre_turn           → onPreTurn
 *   3. pre_tool_use       → onBeforeTool
 *   4. post_tool_use      → onAfterTool
 *   5. stop               → onStop
 */

export interface HookEvent {
  readonly type: string;
}

export interface UserPromptSubmitEvent extends HookEvent {
  readonly type: "user_prompt_submit";
  readonly prompt: string;
}

export interface PreTurnEvent extends HookEvent {
  readonly type: "pre_turn";
}

export interface PreToolUseEvent extends HookEvent {
  readonly type: "pre_tool_use";
  readonly call: ToolCall;
}

export interface PostToolUseEvent extends HookEvent {
  readonly type: "post_tool_use";
  readonly call: ToolCall;
  readonly result: AgentToolResult;
}

export interface StopEvent extends HookEvent {
  readonly type: "stop";
  readonly messages: readonly Message[];
}

export type HookEventUnion =
  | UserPromptSubmitEvent
  | PreTurnEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | StopEvent;

export interface HookResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly messages?: readonly Message[];
  readonly context?: string;
  readonly forceContinue?: string;
}

export interface Hook<TEvent extends HookEvent = HookEvent> {
  readonly name: string;
  readonly eventType: TEvent["type"];
  execute(event: TEvent): HookResult | void | Promise<HookResult | void>;
}
