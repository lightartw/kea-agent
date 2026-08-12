import type { AgentMessage } from "../types.js";

export interface HookEvent<TType extends string> {
  readonly type: TType;
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
  extends HookEvent<"user_prompt"> {
  readonly type: "user_prompt";
  readonly prompt: string;
}

export interface ContextResult {
  readonly messages?: AgentMessage[];
}

export interface ContextEvent
  extends HookEvent<"context"> {
  readonly type: "context";
  readonly messages: AgentMessage[];
}

export interface ToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface ToolCallEvent
  extends HookEvent<"tool_call"> {
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
  extends HookEvent<"tool_result"> {
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

export interface StopEvent extends HookEvent<"stop"> {
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

export type HookListener<TEvent, TContext> = (
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
