import type { TObject } from "typebox";

// ── LLM-facing tool definition (thin, no execute) ──

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}

// ── Wire-format tool call ──

export interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type FinishReason = "stop" | "length" | "tool_calls" | null;

// ── Conversation messages (no system role) ──

export interface Message {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface LLMResponse {
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly finishReason: FinishReason;
}

export type LLMStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "response_done"; readonly response: LLMResponse };

export interface LLMOptions {
  readonly timeout: number;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}

export interface LLMConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly options: LLMOptions;
}

// ── Request context (replaces separate params) ──

export interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

// ── LLM client interface ──

export interface LLMClient {
  invoke(
    context: Context,
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse>;

  stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent>;
}
