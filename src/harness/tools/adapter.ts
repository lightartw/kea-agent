import type { Static, TObject } from "typebox";

import { AgentTool } from "../../agent/tools/types.js";
import type { ToolDefinition } from "./types.js";

/**
 * Thin adapter: fulfills the agent-kernel Tool contract by delegating
 * execution to a ToolDefinition. Schema generation and validation stay on the
 * Tool base class; the adapter only bridges execute().
 */
class AdapterTool<T extends TObject> extends AgentTool<T> {
  constructor(private readonly def: ToolDefinition<T>) {
    super(def.name, def.description, def.parameters);
  }

  async execute(
    arguments_: Static<T>,
    signal: AbortSignal,
  ): Promise<string> {
    return this.def.execute(arguments_, signal);
  }
}

/**
 * Wrap a coding-layer ToolDefinition as an agent-kernel Tool so ToolRegistry
 * can consume it without knowing about UI or execution backends.
 */
export function wrapToolDefinition<T extends TObject>(
  definition: ToolDefinition<T>,
): AgentTool<T> {
  return new AdapterTool(definition);
}
