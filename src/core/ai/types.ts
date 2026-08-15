import type { TObject } from "typebox";

// ── Tool types ──

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}

export interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolResultMessage<TDetails = unknown> {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly details?: TDetails;
  readonly isError?: boolean;
}

// ── Content blocks (ordered within an assistant message) ──
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature?: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCall;

// ── other class that assistant need ──

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
// ── Messages (discriminated union) ──

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
  readonly model: string;
  readonly usage?: TokenUsage;
  readonly stopReason: StopReason;
  readonly errorMessage?: string;
  readonly latencyMs: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ── Streaming events ──

export type StreamChunk =
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: ToolCall }
  | { readonly type: "done";            readonly message: AssistantMessage }
  | { readonly type: "error";           readonly message: AssistantMessage };

// ── Options ──

export interface StreamOptions {
  readonly timeout?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  readonly signal?: AbortSignal;
}

// ── Context ──

export interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

// ── Model routing ──

export interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}

// ── Stream function (replaces LLMClient interface) ──

export type StreamFn = (
  model: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<StreamChunk>;
