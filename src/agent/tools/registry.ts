import { runWithTimeout } from "../../utils/timeout.js";
import { AgentTool, type AgentToolCall, type AgentToolResult } from "./types.js";
import type { Tool } from "../../ai/types.js";
import type { Events } from "../../events/events.js";

const ERROR_PREFIX = "Error: ";

/** Validates and executes tool calls through the three Tool interception stages. */
export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(private readonly timeout = 120) {}

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

  /** All registered tools with full AgentTool type (not just the Tool interface). */
  all(): AgentTool[] {
    return [...this.tools.values()];
  }

  private error(message: string): AgentToolResult {
    return { content: message.startsWith(ERROR_PREFIX) ? message : `${ERROR_PREFIX}${message}`, isError: true };
  }

  /**
   * Run one Tool Call through pre-execute, execute, and post-execute.
   * Returns the final AgentToolResult; every call produces exactly one result.
   */
  async execute(
    call: AgentToolCall,
    events: Events,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    try {
      const preResult = await events.intercept(
        "tools/pre-execute",
        call,
        async (effectiveCall) => effectiveCall,
        signal,
      );

      if ("content" in preResult) {
        return preResult as AgentToolResult<unknown>;
      }
      const effectiveCall = preResult;

      const tool = this.tools.get(effectiveCall.name);
      if (tool === undefined) {
        return this.error(`Unknown tool '${effectiveCall.name}'`);
      }
      const validationError = tool.validate(effectiveCall.arguments);
      if (validationError !== undefined) {
        return this.error(`Invalid arguments for tool '${effectiveCall.name}': ${validationError}`);
      }

      const executed = await events.intercept(
        "tools/execute",
        effectiveCall,
        async (callToRun) =>
          runWithTimeout(this.timeout, (timeoutSignal) =>
            tool.execute(callToRun.arguments, timeoutSignal), signal),
        signal,
      );

      const finalized = await events.intercept(
        "tools/post-execute",
        { call: effectiveCall, result: executed },
        async (input) => input.result,
        signal,
      );

      return finalized;
    } catch (error) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }
}
