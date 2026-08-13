import type { AgentMessage } from "../types.js";

export interface HookCall<TType extends string> {
  readonly type: TType;
}

export type ResultOf<TCall> =
  TCall extends BeforeUserPromptCall ? BeforeUserPromptResult :
  TCall extends TransformContextCall ? TransformContextResult :
  TCall extends BeforeToolCall ? BeforeToolCallResult :
  TCall extends AfterToolCall ? AfterToolCallPatch :
  TCall extends BeforeStopCall ? BeforeStopResult :
  void;

// ── Concrete call types ──

export interface BeforeUserPromptResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface BeforeUserPromptCall
  extends HookCall<"user_prompt"> {
  readonly type: "user_prompt";
  readonly prompt: string;
}

export interface TransformContextResult {
  readonly messages?: AgentMessage[];
}

export interface TransformContextCall
  extends HookCall<"context"> {
  readonly type: "context";
  readonly messages: readonly AgentMessage[];
}

export interface BeforeToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface BeforeToolCall
  extends HookCall<"tool_call"> {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  input: Record<string, unknown>;
}

export type AfterToolCallPatch =
  | { readonly content?: string; readonly details?: never; readonly isError?: boolean }
  | { readonly content: string; readonly details: unknown; readonly isError?: boolean };

export interface AfterToolCall
  extends HookCall<"tool_result"> {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly details?: unknown;
  readonly isError: boolean;
}

export interface BeforeStopResult {
  readonly continueWith?: AgentMessage;
}

export interface BeforeStopCall extends HookCall<"stop"> {
  readonly type: "stop";
  readonly messages: readonly AgentMessage[];
}

// ── Call union ──

export type AgentHookCall =
  | BeforeUserPromptCall
  | TransformContextCall
  | BeforeToolCall
  | AfterToolCall
  | BeforeStopCall;

// ── Handler / Lifecycle ──

export type HookHandler<TCall, TContext> = (
  call: TCall,
  context: TContext,
  signal?: AbortSignal,
) =>
  | ResultOf<TCall>
  | void
  | Promise<ResultOf<TCall> | void>;

export type Cleanup = () => void | Promise<void>;

export type Unregister = () => void;

// ── Narrow trigger interface ──

export interface AgentHookTrigger {
  trigger<TCall extends AgentHookCall>(
    call: TCall,
    signal?: AbortSignal,
  ): Promise<ResultOf<TCall> | undefined>;
}
