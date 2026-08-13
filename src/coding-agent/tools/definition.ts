import type { Static, TObject } from "typebox";
import type { AgentToolResult } from "../../agent/tools/types.js";
import type { CodingToolPresentation } from "../ui/presentation/types.js";

export interface CodingToolContext {
  readonly cwd: string;
}

export interface CodingToolDefinition<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
    context: CodingToolContext,
  ): Promise<AgentToolResult<TDetails>>;
  readonly presentation?: CodingToolPresentation<Static<TParameters>, TDetails>;
}
