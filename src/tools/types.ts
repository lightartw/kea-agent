/** The OpenAI-style definition sent to every LLM provider. */
export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** A model request for the registry to run one tool. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** The registry's result, returned to both the model and the terminal. */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}
