import type { TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";

import type { ToolCall, ToolSchema } from "../llm-client/models.js";
import {
  TimeoutError,
  runWithTimeout,
  timeoutMilliseconds,
} from "../utils/timeout.js";
import { Tool, toolResult, type ToolResult } from "./base.js";
import { ToolExecutionError } from "./errors.js";

const ERROR_PREFIX = "Error: ";

interface RegisteredTool {
  readonly tool: Tool<TObject>;
  readonly validator: Validator;
}

export interface ToolRegistryOptions {
  readonly defaultTimeout?: number;
  readonly maxResultChars?: number;
}

export class ToolRegistry {
  readonly defaultTimeout: number;
  readonly maxResultChars: number;
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTimeout = options.defaultTimeout ?? 120;
    this.maxResultChars = options.maxResultChars ?? 50_000;
    timeoutMilliseconds(this.defaultTimeout);
    if (!Number.isInteger(this.maxResultChars) || this.maxResultChars < 1) {
      throw new Error("maxResultChars must be a positive integer");
    }
  }

  register(tool: Tool<TObject>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered`);
    }
    if (tool.timeout !== null) timeoutMilliseconds(tool.timeout);
    this.tools.set(tool.name, {
      tool,
      validator: Compile(tool.parameters),
    });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ tool }) => tool.toSchema());
  }

  private result(content: string, isError = false): ToolResult {
    return toolResult(content.slice(0, this.maxResultChars), isError);
  }

  private error(message: string): ToolResult {
    return this.result(
      message.startsWith(ERROR_PREFIX) ? message : `${ERROR_PREFIX}${message}`,
      true,
    );
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const registered = this.tools.get(call.name);
    if (registered === undefined) {
      return this.error(`Unknown tool '${call.name}'`);
    }
    if (!registered.validator.Check(call.arguments)) {
      const detail = registered.validator.Errors(call.arguments)[0]?.message;
      return this.error(
        `Invalid arguments for tool '${call.name}': ${detail ?? "validation failed"}`,
      );
    }

    const timeout = registered.tool.timeout ?? this.defaultTimeout;
    try {
      const content = await runWithTimeout(timeout, (timeoutSignal) =>
        registered.tool.execute(call.arguments, timeoutSignal),
      );
      return this.result(content);
    } catch (error) {
      if (error instanceof TimeoutError) {
        return this.error(
          `Tool '${call.name}' timed out after ${timeout} seconds`,
        );
      }
      if (error instanceof ToolExecutionError) return this.error(error.message);
      return this.error(
        `Tool '${call.name}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
