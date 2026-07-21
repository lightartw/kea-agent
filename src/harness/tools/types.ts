import type { Static, TObject } from "typebox";

/**
 * Business-logic definition for one tool. Coding-layer tools implement this
 * plain interface instead of extending the agent-kernel Tool class, so they
 * never import from agent/. Optional UI rendering hooks are reserved for the
 * future TUI layer.
 */
export interface ToolDefinition<TParameters extends TObject = TObject> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
  ): Promise<string>;
}

/**
 * Swappable execution backend for shell commands. The default implementation
 * spawns a local child process; callers can inject SSH, Docker, or other
 * backends without touching tool logic.
 */
export interface BashOperations {
  exec(command: string, cwd: string, signal: AbortSignal): Promise<string>;
}
