import type { Static, TSchema } from "typebox";

import type { ToolSchema } from "../llm-client/models.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

export function toolResult(content: string, isError = false): ToolResult {
  return { content, isError };
}

export abstract class Tool<TParameters extends TSchema = TSchema> {
  readonly parameters: TParameters;

  protected constructor(
    readonly name: string,
    readonly description: string,
    parameters: TParameters,
    readonly timeout: number | null = null,
  ) {
    this.parameters = deepFreeze(clone(parameters));
  }

  toSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: clone(this.parameters) as unknown as Record<string, unknown>,
      },
    };
  }

  abstract execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
  ): Promise<string>;
}
