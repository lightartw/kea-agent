import type { AgentToolCall, AgentToolResult } from "../../../agent/tools/types.js";
import type { ToolRejectedReason } from "../../../agent/types.js";

export type ToolPresentationOutput = string;

export type ToolPresentationCall<TArguments> =
  Omit<AgentToolCall, "arguments"> & { readonly arguments: TArguments };

export interface ToolPresentationRejected<TArguments> {
  readonly call: ToolPresentationCall<TArguments>;
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult<unknown>;
  readonly reason: ToolRejectedReason;
}

export interface CodingToolPresentation<TArguments, TDetails> {
  renderStart(call: ToolPresentationCall<TArguments>): ToolPresentationOutput | undefined;
  renderEnd(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): ToolPresentationOutput | undefined;
  renderRejected?(
    event: ToolPresentationRejected<TArguments>,
  ): ToolPresentationOutput | undefined;
}
