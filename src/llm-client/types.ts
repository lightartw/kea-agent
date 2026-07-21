import type { ToolCall, ToolSchema } from "../tools/types.js";

export type FinishReason = "stop" | "length" | "tool_calls" | null;

export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
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

export interface LLMClient {
  invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse>;

  stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent>;
}
