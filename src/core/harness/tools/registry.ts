import { errorMessage, runWithTimeout } from "../../util/index.js";
import {
  AgentTool,
  type AgentToolCall,
  type AgentToolResult,
  type ToolExecutionContext,
} from "./types.js";
import type { Tool } from "../../ai/types.js";
import type { HookContext } from "../events.js";

const ERROR_PREFIX = "Error: ";

/** Validates and executes tool calls; permission is a fixed beforeTool hook. */
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
   * Run one Tool Call: validate, consult the beforeTool permission hook, then
   * execute with the configured timeout. The call is the first parameter; the
   * context carries Run identity, execution cwd, hooks, and cancellation.
   * Returns exactly one AgentToolResult per call.
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

      const hookCtx: HookContext = {
        sessionId: executionContext.sessionId,
        runId: executionContext.runId,
        cwd: executionContext.cwd,
        ...(executionContext.signal === undefined
          ? {}
          : { signal: executionContext.signal }),
      };
      const preDecision = await executionContext.hooks.beforeTool(call, hookCtx);
      if (preDecision.kind === "deny") {
        return this.error(preDecision.reason ?? "Tool execution denied");
      }

      return await runWithTimeout(
        this.timeout,
        (timeoutSignal) => tool.execute(call.arguments, timeoutSignal),
        executionContext.signal,
      );
    } catch (error) {
      return this.error(errorMessage(error));
    }
  }
}
