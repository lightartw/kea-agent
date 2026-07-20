import { Compile, type Validator } from "typebox/compile";
import type { TSchema } from "typebox";

import {
  combineAbortSignals,
  raceWithSignal,
  timeoutMilliseconds,
} from "../utils/abort-signals.js";
import { Tool, toolResult, type ToolResult } from "./base.js";
import {
  ToolConfigurationError,
  ToolExecutionError,
} from "./errors.js";
import type { ToolSchema } from "../llm-client/models.js";

const ERROR_PREFIX = "Error: ";

interface RegisteredTool {
  readonly tool: Tool<TSchema>;
  readonly validator: Validator;
}

export interface ToolRegistryOptions {
  readonly defaultTimeout?: number;
  readonly maxResultChars?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateTimeoutRange(value: number, label: string): void {
  try {
    timeoutMilliseconds(value);
  } catch (error) {
    throw new ToolConfigurationError(`${label} exceeds the Node timer range`, {
      cause: error,
    });
  }
}

export class ToolRegistry {
  readonly defaultTimeout: number;
  readonly maxResultChars: number;
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(options: ToolRegistryOptions = {}) {
    const defaultTimeout = options.defaultTimeout ?? 120;
    const maxResultChars = options.maxResultChars ?? 50_000;
    if (!positiveFinite(defaultTimeout)) {
      throw new ToolConfigurationError(
        "defaultTimeout must be a positive finite number",
      );
    }
    validateTimeoutRange(defaultTimeout, "defaultTimeout");
    if (
      !Number.isInteger(maxResultChars) ||
      maxResultChars < ERROR_PREFIX.length
    ) {
      throw new ToolConfigurationError(
        `maxResultChars must be an integer of at least ${ERROR_PREFIX.length}`,
      );
    }
    this.defaultTimeout = defaultTimeout;
    this.maxResultChars = maxResultChars;
  }

  private validateTool(tool: Tool<TSchema>): Validator {
    if (!(tool instanceof Tool)) {
      throw new ToolConfigurationError("tool must be a Tool instance");
    }
    if (typeof tool.name !== "string" || !tool.name.trim()) {
      throw new ToolConfigurationError("tool name must be non-empty");
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new ToolConfigurationError("tool description must be non-empty");
    }
    if (tool.timeout !== null && !positiveFinite(tool.timeout)) {
      throw new ToolConfigurationError(
        "tool timeout must be a positive finite number",
      );
    }
    if (tool.timeout !== null) validateTimeoutRange(tool.timeout, "tool timeout");
    if (!isRecord(tool.parameters)) {
      throw new ToolConfigurationError("tool parameters must be an object");
    }
    if (tool.parameters.type !== "object") {
      throw new ToolConfigurationError("parameter schema root type must be object");
    }
    const properties = tool.parameters.properties ?? {};
    if (!isRecord(properties)) {
      throw new ToolConfigurationError(
        "parameter schema properties must be an object",
      );
    }
    const required = tool.parameters.required ?? [];
    if (
      !Array.isArray(required) ||
      !required.every((name: unknown) => typeof name === "string")
    ) {
      throw new ToolConfigurationError(
        "parameter schema required must be an array of strings",
      );
    }
    const undeclared = required
      .filter((name: string) => !(name in properties))
      .sort();
    if (undeclared[0] !== undefined) {
      throw new ToolConfigurationError(
        `required property is not declared: ${undeclared[0]}`,
      );
    }
    try {
      return Compile(tool.parameters);
    } catch (error) {
      throw new ToolConfigurationError(
        `invalid parameter schema for tool '${tool.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  register(tool: Tool<TSchema>): void {
    const validator = this.validateTool(tool);
    if (this.tools.has(tool.name)) {
      throw new ToolConfigurationError(
        `tool '${tool.name}' is already registered`,
      );
    }
    this.tools.set(tool.name, { tool, validator });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool<TSchema> | undefined {
    return this.tools.get(name)?.tool;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ tool }) => tool.toSchema());
  }

  private result(content: string, isError = false): ToolResult {
    return toolResult(content.slice(0, this.maxResultChars), isError);
  }

  private error(message: string): ToolResult {
    const content = message.startsWith(ERROR_PREFIX)
      ? message
      : `${ERROR_PREFIX}${message}`;
    return this.result(content, true);
  }

  async execute(
    name: string,
    arguments_: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const registered = this.tools.get(name);
    if (registered === undefined) {
      return this.error(`Unknown tool '${name}'`);
    }
    if (!isRecord(arguments_)) {
      return this.error(`arguments must be an object for tool '${name}'`);
    }
    if (!registered.validator.Check(arguments_)) {
      const detail = registered.validator.Errors(arguments_)[0]?.message;
      return this.error(
        `Invalid arguments for tool '${name}': ${detail ?? "validation failed"}`,
      );
    }
    if (callerSignal?.aborted) throw callerSignal.reason;

    const timeout = registered.tool.timeout ?? this.defaultTimeout;
    const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(timeout));
    const combined = combineAbortSignals([callerSignal, timeoutSignal]);
    try {
      const content = await raceWithSignal(
        registered.tool.execute(arguments_, combined.signal!),
        combined.signal!,
      );
      if (typeof content !== "string") {
        return this.error(`Tool '${name}' must return a string`);
      }
      return this.result(content);
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (timeoutSignal.aborted) {
        return this.error(`Tool '${name}' timed out after ${timeout} seconds`);
      }
      if (error instanceof ToolExecutionError) return this.error(error.message);
      return this.error(
        `Tool '${name}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      combined.cleanup();
    }
  }
}
