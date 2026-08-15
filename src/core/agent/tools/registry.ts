import { errorMessage, runWithTimeout } from "../../util/index.js";
import type { PreToolDecision } from "./events.js";
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
    const content = message.startsWith(ERROR_PREFIX)
      ? message
      : `${ERROR_PREFIX}${message}`;
    return { content, isError: true };
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
      const preDecision = await events.intercept(
        "tools/pre-execute",
        call,
        (): PreToolDecision => ({ kind: "allow" }),
        signal,
      );
      if (preDecision.kind === "deny") {
        return this.error(preDecision.reason ?? "Tool execution denied");
      }

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

      const result = await events.intercept(
        "tools/execute",
        call,
        (callToRun) =>
          runWithTimeout(
            this.timeout,
            (timeoutSignal) =>
              tool.execute(callToRun.arguments, timeoutSignal),
            signal,
          ),
        signal,
      );

      return await events.intercept(
        "tools/post-execute",
        { call, result },
        (input) => input.result,
        signal,
      );
    } catch (error) {
      return this.error(errorMessage(error));
    }
  }
}
