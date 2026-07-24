import type { HookRegistry } from "../hooks/registry.js";
import { runWithTimeout, timeoutMilliseconds } from "../../utils/timeout.js";
import { AgentTool, type ToolResult } from "./types.js";
import type { Tool, ToolCall } from "../../llm-client/types.js";

const ERROR_PREFIX = "Error: ";

/** The single validated, hook-aware execution path for every registered tool. */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(
    private readonly timeout = 120,
    private readonly hooks?: HookRegistry,
  ) {
    timeoutMilliseconds(timeout);
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  schemas(): Tool[] {
    return [...this.tools.values()]; // AgentTool implements Tool
  }

  private error(message: string): ToolResult {
    return { content: message.startsWith(ERROR_PREFIX) ? message : `${ERROR_PREFIX}${message}`, isError: true };
  }

  /**
   * Resolve and validate first, then run pre-tool hooks, and only then start the
   * execution timeout. Time spent waiting for human approval is intentionally
   * excluded from the tool's runtime budget.
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return this.error(`Unknown tool '${call.name}'`);
    }
    const validationError = tool.validate(call.arguments);
    if (validationError !== undefined) {
      return this.error(
        `Invalid arguments for tool '${call.name}': ${validationError}`,
      );
    }

    // This is the mandatory AOP gate: a block or hook failure never reaches
    // runWithTimeout(), so no tool process or file operation has started yet.
    if (this.hooks !== undefined) {
      try {
        const result = await this.hooks.trigger({ type: "pre_tool_use", call });
        if (result?.block === true) return this.error(result.reason ?? "blocked by hook");
      } catch (error) {
        return this.error(error instanceof Error ? error.message : String(error));
      }
    }

    let toolResult: ToolResult;
    try {
      const content = await runWithTimeout(this.timeout, (timeoutSignal) =>
        tool.execute(call.arguments, timeoutSignal),
      );
      toolResult = { content, isError: false };
    } catch (error) {
      toolResult = this.error(error instanceof Error ? error.message : String(error));
    }

    // ③ PostToolUse — side-effect hooks (logging, auto-git-add) fire after
    // execution regardless of success/failure.
    if (this.hooks !== undefined) {
      try {
        await this.hooks.trigger({
          type: "post_tool_use",
          call,
          result: toolResult,
        });
      } catch {
        // Post hooks are side-effects; failures must not affect the tool result.
      }
    }

    return toolResult;
  }
}
