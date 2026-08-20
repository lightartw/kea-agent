import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";

import type { Tool } from "../../ai/types.js";
import type { HarnessHooks } from "../hooks.js";

/** The result returned by AgentTool.execute(), before being wrapped into a ToolResultMessage. */
export interface AgentToolResult<TDetails = unknown> {
  readonly content: string;
  readonly details?: TDetails;
  readonly isError: boolean;
}

/** A tool call requested by the model. Agent-side equivalent of ai.ToolCall. */
export interface AgentToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Everything the Registry needs to orchestrate one Tool Call: Run identity,
 * execution cwd, the fixed control hooks, and Run cancellation. The call
 * itself is the first parameter of `execute(call, context)`; it stays outside
 * so the primary object of a Tool execution is always explicit. Built-in
 * tools never see this; they only receive validated arguments plus a timeout
 * signal.
 */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly hooks: HarnessHooks;
  readonly signal?: AbortSignal;
}

/** Agent-side tool: schema + validation + execution. Implements the ai layer Tool interface. */
export abstract class AgentTool<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> implements Tool {
  private readonly validator: Validator;

  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
  ) {
    this.validator = Compile(parameters);
  }

  /** Keep TypeBox details with the schema that defines valid arguments. */
  validate(arguments_: unknown): string | undefined {
    if (this.validator.Check(arguments_)) return undefined;
    return this.validator.Errors(arguments_)[0]?.message ?? "validation failed";
  }

  abstract execute(
    arguments_: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}
