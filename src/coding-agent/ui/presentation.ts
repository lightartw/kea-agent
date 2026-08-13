import type { AgentToolCall, AgentToolResult } from "../../agent/tools/types.js";
import type { ToolRejectedReason } from "../../agent/types.js";
import type { HarnessToolEvent } from "../../harness/events/types.js";

export type ToolPresentationCall<TArguments> =
  Omit<AgentToolCall, "arguments"> & { readonly arguments: TArguments };

export interface ToolPresentationRejected<TArguments> {
  readonly call: ToolPresentationCall<TArguments>;
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult<unknown>;
  readonly reason: ToolRejectedReason;
}

export interface CodingToolPresentation<TArguments, TDetails> {
  renderStart(call: ToolPresentationCall<TArguments>): string | undefined;
  renderEnd(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): string | undefined;
  renderRejected?(
    event: ToolPresentationRejected<TArguments>,
  ): string | undefined;
}

type ErasedPresentation = CodingToolPresentation<unknown, unknown>;

function fallbackStart(call: AgentToolCall): string {
  let argumentsText: string;
  try {
    argumentsText = JSON.stringify(call.arguments);
  } catch {
    argumentsText = "[unserializable arguments]";
  }
  return `[exec] ${call.name}: ${argumentsText}`;
}

function fallbackEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string {
  return result.isError
    ? `[error] ${call.name}: ${result.content}`
    : `[done] ${call.name}: ${result.content}`;
}

function fallbackRejected(event: ToolPresentationRejected<unknown>): string {
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
    const presentation = this.presentations.get(event.call.name);
    try {
      switch (event.type) {
        case "tool_start":
          return presentation?.renderStart(event.call) ?? fallbackStart(event.call);
        case "tool_end":
          return presentation?.renderEnd(event.call, event.result) ??
            fallbackEnd(event.call, event.result);
        case "tool_rejected":
          return presentation?.renderRejected?.(event) ?? fallbackRejected(event);
      }
    } catch (error) {
      this.report(error);
      switch (event.type) {
        case "tool_start": return fallbackStart(event.call);
        case "tool_end": return fallbackEnd(event.call, event.result);
        case "tool_rejected": return fallbackRejected(event);
      }
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
