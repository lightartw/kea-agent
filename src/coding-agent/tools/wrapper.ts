import type { Static, TObject } from "typebox";
import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";
import type { CodingToolContext, CodingToolDefinition } from "./definition.js";

class CodingAgentToolAdapter<
  TParameters extends TObject,
  TDetails,
> extends AgentTool<TParameters, TDetails> {
  constructor(
    private readonly definition: CodingToolDefinition<TParameters, TDetails>,
    private readonly context: CodingToolContext,
  ) {
    super(definition.name, definition.description, definition.parameters);
  }

  async execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
  ): Promise<AgentToolResult<TDetails>> {
    return this.definition.execute(arguments_, signal, this.context);
  }
}

export function toAgentTool<TParameters extends TObject, TDetails>(
  definition: CodingToolDefinition<TParameters, TDetails>,
  context: CodingToolContext,
): AgentTool<TParameters, TDetails> {
  return new CodingAgentToolAdapter(definition, context);
}
