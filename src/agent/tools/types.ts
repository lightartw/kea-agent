import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";

import type { Tool } from "../../llm-client/types.js";

/** The registry's result, returned to both the model and the terminal. */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** Agent-side tool: schema + validation + execution. Implements the llm-client Tool interface. */
export abstract class AgentTool<TParameters extends TObject = TObject> implements Tool {
  private readonly validator: Validator;

  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
  ) {
    this.validator = Compile(parameters);
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

