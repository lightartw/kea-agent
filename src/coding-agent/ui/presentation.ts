import type { AgentToolCall, AgentToolResult } from "../../agent/tools/types.js";

export type ToolPresentationCall<TArguments> =
  Omit<AgentToolCall, "arguments"> & { readonly arguments: TArguments };

export type ToolPresentationInput =
  | { readonly type: "call"; readonly call: AgentToolCall }
  | {
      readonly type: "result";
      readonly call: AgentToolCall;
      readonly result: AgentToolResult;
    };

export interface CodingToolPresentation<TArguments, TDetails> {
  renderCall(
    call: ToolPresentationCall<TArguments>,
  ): string | undefined;
  renderResult(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): string | undefined;
}

type ErasedPresentation = CodingToolPresentation<unknown, unknown>;

function fallbackCall(call: AgentToolCall): string {
  let argumentsText: string;
  try {
    argumentsText = JSON.stringify(call.arguments);
  } catch {
    argumentsText = "[unserializable arguments]";
  }
  return `[exec] ${call.name}: ${argumentsText}`;
}

function fallbackResult(call: AgentToolCall, result: AgentToolResult<unknown>): string {
  return result.isError
    ? `[error] ${call.name}: ${result.content}`
    : `[done] ${call.name}: ${result.content}`;
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
        case "call":
          return presentation?.renderCall(input.call) ?? fallbackCall(input.call);
        case "result":
          return presentation?.renderResult(input.call, input.result) ??
            fallbackResult(input.call, input.result);
      }
    } catch (error) {
      this.report(error);
      switch (input.type) {
        case "call": return fallbackCall(input.call);
        case "result": return fallbackResult(input.call, input.result);
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
