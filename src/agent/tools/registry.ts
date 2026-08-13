import { runWithTimeout } from "../../utils/timeout.js";
import { AgentTool, type AgentToolCall, type AgentToolResult } from "./types.js";
import type { Tool } from "../../ai/types.js";

const ERROR_PREFIX = "Error: ";

interface PreparedAgentToolCall {
  readonly call: AgentToolCall;
  readonly tool: AgentTool;
}

type ToolPreparation =
  | { readonly kind: "ready"; readonly prepared: PreparedAgentToolCall }
  | {
      readonly kind: "rejected";
      readonly reason: "unknown" | "invalid";
      readonly result: AgentToolResult<unknown>;
    };

/** Validates and executes tool calls. Does not know about hooks. */
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

  /** Look up and validate a call without executing it. */
  prepare(call: AgentToolCall): ToolPreparation {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return { kind: "rejected", reason: "unknown", result: this.error(`Unknown tool '${call.name}'`) };
    }
    const validationError = tool.validate(call.arguments);
    if (validationError !== undefined) {
      return {
        kind: "rejected",
        reason: "invalid",
        result: this.error(`Invalid arguments for tool '${call.name}': ${validationError}`),
      };
    }
    return { kind: "ready", prepared: { call, tool } };
  }

  /** Execute a previously prepared call. Hooks are handled by the caller. */
  async execute(
    prepared: PreparedAgentToolCall,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    try {
      return await runWithTimeout(this.timeout, (timeoutSignal) =>
        prepared.tool.execute(prepared.call.arguments, timeoutSignal), signal);
    } catch (error) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }
}
