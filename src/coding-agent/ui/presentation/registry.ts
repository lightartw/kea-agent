import type { AgentToolCall, AgentToolResult } from "../../../agent/tools/types.js";
import type { HarnessToolEvent } from "../../../harness/events/types.js";
import type {
  CodingToolPresentation,
  ToolPresentationRejected,
  ToolPresentationOutput,
} from "./types.js";

type ErasedPresentation = CodingToolPresentation<unknown, unknown>;

function fallbackStart(call: AgentToolCall): ToolPresentationOutput {
  let argumentsText: string;
  try {
    argumentsText = JSON.stringify(call.arguments);
  } catch {
    argumentsText = "[unserializable arguments]";
  }
  return `[exec] ${call.name}: ${argumentsText}`;
}

function fallbackEnd(call: AgentToolCall, result: AgentToolResult<unknown>): ToolPresentationOutput {
  return result.isError
    ? `[error] ${call.name}: ${result.content}`
    : `[done] ${call.name}: ${result.content}`;
}

function fallbackRejected(event: ToolPresentationRejected<unknown>): ToolPresentationOutput {
  return `[rejected:${event.reason}] ${event.call.name}: ${event.result.content}`;
}

export class CodingToolPresentationRegistry {
  private readonly presentations = new Map<string, ErasedPresentation>();

  constructor(
    private readonly onError: (message: string) => void = () => undefined,
  ) {}

  register<TArguments, TDetails>(
    name: string,
    presentation: CodingToolPresentation<TArguments, TDetails>,
  ): void {
    if (this.presentations.has(name)) {
      throw new Error(`tool presentation '${name}' is already registered`);
    }
    this.presentations.set(name, presentation as ErasedPresentation);
  }

  render(event: HarnessToolEvent): string {
    switch (event.type) {
      case "tool_start":
        return this.renderStart(event.call);
      case "tool_end":
        return this.renderEnd(event.call, event.result);
      case "tool_rejected":
        return this.renderRejected(event);
    }
  }

  private renderStart(call: AgentToolCall): string {
    const presentation = this.presentations.get(call.name);
    if (presentation === undefined) return fallbackStart(call);
    try {
      return presentation.renderStart(call) ?? fallbackStart(call);
    } catch (error) {
      this.report(error);
      return fallbackStart(call);
    }
  }

  private renderEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string {
    const presentation = this.presentations.get(call.name);
    if (presentation === undefined) return fallbackEnd(call, result);
    try {
      return presentation.renderEnd(call, result) ?? fallbackEnd(call, result);
    } catch (error) {
      this.report(error);
      return fallbackEnd(call, result);
    }
  }

  private renderRejected(event: ToolPresentationRejected<unknown>): string {
    const presentation = this.presentations.get(event.call.name);
    if (presentation === undefined || presentation.renderRejected === undefined) {
      return fallbackRejected(event);
    }
    try {
      return presentation.renderRejected(event) ?? fallbackRejected(event);
    } catch (error) {
      this.report(error);
      return fallbackRejected(event);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError(error instanceof Error ? error.message : String(error));
    } catch {
      // Presentation diagnostics must not re-enter execution.
    }
  }
}
