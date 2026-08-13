import type { AgentToolCall, AgentToolResult } from "../../agent/tools/types.js";
import type { ToolRejectedReason } from "../../agent/events.js";

export type ToolPresentationCall<TArguments> =
  Omit<AgentToolCall, "arguments"> & { readonly arguments: TArguments };

export interface ToolPresentationRejected<TArguments> {
  readonly call: ToolPresentationCall<TArguments>;
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult<unknown>;
  readonly reason: ToolRejectedReason;
}

export type ToolPresentationInput =
  | { readonly type: "tool_start"; readonly call: AgentToolCall }
  | { readonly type: "tool_end"; readonly call: AgentToolCall; readonly result: AgentToolResult }
  | ({ readonly type: "tool_rejected" } & ToolPresentationRejected<unknown>);

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

  render(input: ToolPresentationInput): string {
    const presentation = this.presentations.get(input.call.name);
    try {
      switch (input.type) {
        case "tool_start":
          return presentation?.renderStart(input.call) ?? fallbackStart(input.call);
        case "tool_end":
          return presentation?.renderEnd(input.call, input.result) ??
            fallbackEnd(input.call, input.result);
        case "tool_rejected":
          return presentation?.renderRejected?.(input) ?? fallbackRejected(input);
      }
    } catch (error) {
      this.report(error);
      switch (input.type) {
        case "tool_start": return fallbackStart(input.call);
        case "tool_end": return fallbackEnd(input.call, input.result);
        case "tool_rejected": return fallbackRejected(input);
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
