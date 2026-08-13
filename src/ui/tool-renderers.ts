import type { AgentToolCall, AgentToolResult } from "../agent/tools/types.js";
import type { ToolRejectedEvent } from "../agent/types.js";
import { createTodoRenderer } from "./todo-renderer.js";

export interface CliToolRenderer {
  renderStart(call: AgentToolCall): string | undefined;
  renderEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string | undefined;
  renderRejected?(event: ToolRejectedEvent): string | undefined;
}

function fallbackStart(call: AgentToolCall): string {
  return `[exec] ${call.name}: ${JSON.stringify(call.arguments)}`;
}

function fallbackEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string {
  return result.isError
    ? `[error] ${call.name}: ${result.content}`
    : `[done] ${call.name}: ${result.content}`;
}

function fallbackRejected(event: ToolRejectedEvent): string {
  return `[rejected:${event.reason}] ${event.call.name}: ${event.result.content}`;
}

export class CliToolRendererRegistry {
  private readonly renderers = new Map<string, CliToolRenderer>();

  constructor(private readonly onError: (message: string) => void) {}

  register(name: string, renderer: CliToolRenderer): void {
    if (this.renderers.has(name)) {
      throw new Error(`tool renderer '${name}' is already registered`);
    }
    this.renderers.set(name, renderer);
  }

  renderStart(call: AgentToolCall): string {
    return this.render(call.name, (renderer) => renderer.renderStart(call), () => fallbackStart(call));
  }

  renderEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string {
    return this.render(call.name, (renderer) => renderer.renderEnd(call, result), () => fallbackEnd(call, result));
  }

  renderRejected(event: ToolRejectedEvent): string {
    return this.render(event.call.name, (renderer) => renderer.renderRejected?.(event), () => fallbackRejected(event));
  }

  private render(
    name: string,
    specialized: (renderer: CliToolRenderer) => string | undefined,
    fallback: () => string,
  ): string {
    const renderer = this.renderers.get(name);
    if (renderer === undefined) return fallback();
    try {
      return specialized(renderer) ?? fallback();
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error));
      return fallback();
    }
  }
}

export function createDefaultToolRenderers(
  onError: (message: string) => void,
): CliToolRendererRegistry {
  const registry = new CliToolRendererRegistry(onError);
  registry.register("todo_write", createTodoRenderer());
  return registry;
}
