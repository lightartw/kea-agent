import { errorMessage, runWithTimeout } from "../../util/index.js";
import type { PreToolDecision, ToolCallEvent } from "./events.js";
import {
  AgentTool,
  type AgentToolCall,
  type AgentToolResult,
  type ToolExecutionContext,
} from "./types.js";
import type { Tool } from "../../ai/types.js";

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
   * The call is the first parameter; the context carries Run identity,
   * execution cwd, events, and cancellation. Returns the final
   * AgentToolResult; every call produces exactly one result.
   */
  async execute(
    call: AgentToolCall,
    executionContext: ToolExecutionContext,
  ): Promise<AgentToolResult<unknown>> {
    try {
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

      const event: ToolCallEvent = {
        sessionId: executionContext.sessionId,
        runId: executionContext.runId,
        cwd: executionContext.cwd,
        call,
      };
      const preDecision = await executionContext.events.intercept(
        "tools/pre-execute",
        event,
        (): PreToolDecision => ({ kind: "allow" }),
        executionContext.signal,
      );
      if (preDecision.kind === "deny") {
        return this.error(preDecision.reason ?? "Tool execution denied");
      }

      const result = await executionContext.events.intercept(
        "tools/execute",
        event,
        (input) =>
          runWithTimeout(
            this.timeout,
            (timeoutSignal) =>
              tool.execute(input.call.arguments, timeoutSignal),
            executionContext.signal,
          ),
        executionContext.signal,
      );

      return await executionContext.events.intercept(
        "tools/post-execute",
        { ...event, result },
        (input) => input.result,
        executionContext.signal,
      );
    } catch (error) {
      return this.error(errorMessage(error));
    }
  }
}
