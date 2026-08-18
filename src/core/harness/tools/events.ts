import type { AgentToolCall, AgentToolResult } from "./types.js";
import type { InterceptEvent } from "../../events/types.js";

/** A Tool Call in one Run: Run identity, execution cwd, and the call itself. */
export interface ToolCallEvent {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly call: AgentToolCall;
}

/** ToolCallEvent plus the execution result. */
export interface ToolResultEvent extends ToolCallEvent {
  readonly result: AgentToolResult;
}

export type PreToolDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason?: string };

declare module "../../events/types.js" {
  interface EventMap {
    "tools/pre-execute": InterceptEvent<ToolCallEvent, PreToolDecision>;

    "tools/execute": InterceptEvent<ToolCallEvent, AgentToolResult>;

    "tools/post-execute": InterceptEvent<ToolResultEvent, AgentToolResult>;
  }
}
