import type { AgentMessage, AgentToolCall, AgentToolResult } from "../agent/index.js";
import type { AgentRunIdentity } from "../agent/types.js";
import type { EmitEvent } from "../events/types.js";

export type HarnessRunEnd = AgentRunIdentity & (
  | { readonly reason: "completed" | "aborted" }
  | { readonly reason: "error"; readonly errorMessage: string }
);

/**
 * UI-facing projection of the emit facts that belong to one Session. Excludes
 * Session identity (the subscription is already bound) and all intercept
 * control points.
 */
export type HarnessEvent =
  | { readonly type: "run-start"; readonly runId: string }
  | ({
      readonly type: "run-end";
      readonly runId: string;
    } & (
      | { readonly reason: "completed" | "aborted" }
      | { readonly reason: "error"; readonly errorMessage: string }
    ))
  | { readonly type: "turn-start"; readonly runId: string }
  | {
      readonly type: "turn-end";
      readonly runId: string;
      readonly message: AgentMessage;
      readonly toolResults: readonly AgentMessage[];
    }
  | { readonly type: "text-delta"; readonly runId: string; readonly text: string }
  | {
      readonly type: "thinking-delta";
      readonly runId: string;
      readonly thinking: string;
    }
  | {
      readonly type: "tool-call-start";
      readonly runId: string;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: "tool-call-delta";
      readonly runId: string;
      readonly id: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "tool-call";
      readonly runId: string;
      readonly cwd: string;
      readonly call: AgentToolCall;
    }
  | {
      readonly type: "tool-result";
      readonly runId: string;
      readonly cwd: string;
      readonly call: AgentToolCall;
      readonly result: AgentToolResult;
    };

declare module "../events/types.js" {
  interface EventMap {
    "harness/run-start": EmitEvent<AgentRunIdentity>;
    "harness/run-end": EmitEvent<HarnessRunEnd>;
  }
}
