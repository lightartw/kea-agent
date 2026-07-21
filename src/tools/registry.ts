import { Compile, type Validator } from "typebox/compile";

import { runWithTimeout, timeoutMilliseconds } from "../utils/timeout.js";
import { Tool } from "./base.js";
import type { ToolCall, ToolResult, ToolSchema } from "./types.js";

const ERROR_PREFIX = "Error: ";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly timeout = 120) {
    timeoutMilliseconds(timeout);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => tool.toSchema());
  }

  private error(message: string): ToolResult {
    return { content: message.startsWith(ERROR_PREFIX) ? message : `${ERROR_PREFIX}${message}`, isError: true };
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return this.error(`Unknown tool '${call.name}'`);
    }
    const validator: Validator = Compile(tool.parameters);
    if (!validator.Check(call.arguments)) {
      const detail = validator.Errors(call.arguments)[0]?.message;
      return this.error(
        `Invalid arguments for tool '${call.name}': ${detail ?? "validation failed"}`,
      );
    }

    try {
      const content = await runWithTimeout(this.timeout, (timeoutSignal) =>
        tool.execute(call.arguments, timeoutSignal),
      );
      return { content, isError: false };
    } catch (error) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }
}
