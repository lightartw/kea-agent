import type { AgentMessage } from "../types.js";

// ── Phantom result symbol ──

declare const HookResult: unique symbol;

export interface HookEvent<TType extends string, TResult = void> {
  readonly type: TType;
  readonly [HookResult]?: TResult;
}

export type ResultOf<TEvent> =
  TEvent extends UserPromptEvent ? UserPromptResult :
  TEvent extends ContextEvent ? ContextResult :
  TEvent extends ToolCallEvent ? ToolCallResult :
  TEvent extends ToolResultEvent ? ToolResultPatch :
  TEvent extends StopEvent ? StopResult :
  void;

// ── Concrete event types ──

export interface UserPromptResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface UserPromptEvent
  extends HookEvent<"user_prompt", UserPromptResult> {
  readonly type: "user_prompt";
  readonly prompt: string;
}

export interface ContextResult {
  readonly messages?: AgentMessage[];
}

export interface ContextEvent
  extends HookEvent<"context", ContextResult> {
  readonly type: "context";
  readonly messages: AgentMessage[];
}

export interface ToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface ToolCallEvent
  extends HookEvent<"tool_call", ToolCallResult> {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultPatch {
  readonly content?: string;
  readonly isError?: boolean;
}

export interface ToolResultEvent
  extends HookEvent<"tool_result", ToolResultPatch> {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: string;
  readonly isError: boolean;
}

export interface StopResult {
  readonly continueWith?: AgentMessage;
}

export interface StopEvent extends HookEvent<"stop", StopResult> {
  readonly type: "stop";
  readonly messages: readonly AgentMessage[];
}

// ── Event union ──

export type AgentHookEvent =
  | UserPromptEvent
  | ContextEvent
  | ToolCallEvent
  | ToolResultEvent
  | StopEvent;

// ── Handler / Observer / Lifecycle ──

export type HookHandler<TEvent, TContext> = (
  event: TEvent,
  context: TContext,
  signal?: AbortSignal,
) =>
  | ResultOf<TEvent>
  | void
  | Promise<ResultOf<TEvent> | void>;

export type HookObserver<TEvent, TContext> = (
  event: TEvent,
  context: TContext,
  signal?: AbortSignal,
) => void | Promise<void>;

export type Cleanup = () => void | Promise<void>;

export type Unregister = () => void;

// ── Narrow trigger interface ──

export interface AgentHookTrigger {
  trigger<TEvent extends AgentHookEvent>(
    event: TEvent,
    signal?: AbortSignal,
  ): Promise<ResultOf<TEvent> | undefined>;
}
