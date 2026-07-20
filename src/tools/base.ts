import type { Static, TObject } from "typebox";

import type { ToolSchema } from "../llm-client/models.js";

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

export function toolResult(content: string, isError = false): ToolResult {
  return { content, isError };
}

export abstract class Tool<TParameters extends TObject = TObject> {
  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
    readonly timeout: number | null = null,
  ) {}

  toSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters as Record<string, unknown>,
      },
    };
  }

  abstract execute(
    arguments_: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<string>;
}
