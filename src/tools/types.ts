import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";

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

/** A tool describes itself to the model and executes one validated call. */
export abstract class Tool<TParameters extends TObject = TObject> {
  private readonly validator: Validator;

  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
  ) {
    this.validator = Compile(parameters);
  }

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

  /** Keep TypeBox details with the schema that defines valid arguments. */
  validate(arguments_: unknown): string | undefined {
    if (this.validator.Check(arguments_)) return undefined;
    return this.validator.Errors(arguments_)[0]?.message ?? "validation failed";
  }

  abstract execute(
    arguments_: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<string>;
}
