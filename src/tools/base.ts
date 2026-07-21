import type { Static, TObject } from "typebox";

import type { ToolSchema } from "./types.js";

export abstract class Tool<TParameters extends TObject = TObject> {
  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
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
