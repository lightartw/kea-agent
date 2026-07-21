export type ProviderName = "anthropic" | "openai" | "gemini";
export type FinishReason = "stop" | "length" | "tool_calls" | null;
export type ToolArguments = Record<string, unknown>;

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: ToolArguments;
}

/**
 * The agent's one history format. Adapters translate it at their boundary so
 * provider-specific message types never spread into the rest of the project.
 *
 * The optional tool fields are meaningful only for `assistant` and `tool`
 * roles. Keeping one shape makes the history easy to read and extend while
 * the agent controls the values it appends.
 */
export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
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
