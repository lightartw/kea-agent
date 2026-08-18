import type { AgentMessage, AgentRunIdentity } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { ToolCallEvent, ToolResultEvent } from "./tools/events.js";
import type { EmitEvent, InterceptEvent } from "../events/types.js";

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
    // Run boundaries owned by the Harness.
    "harness/run-start": EmitEvent<AgentRunIdentity>;
    "harness/run-end": EmitEvent<HarnessRunEnd>;

    // Control interceptors dispatched with intercept().
    "agent/user-prompt": InterceptEvent<
      AgentRunIdentity & { readonly prompt: string },
      string | undefined
    >;
    "agent/context": InterceptEvent<
      AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      readonly AgentMessage[]
    >;

    // Facts dispatched with emit().
    "agent/turn-start": EmitEvent<AgentRunIdentity>;
    "agent/turn-end": EmitEvent<
      AgentRunIdentity & {
        readonly message: AgentMessage;
        readonly toolResults: readonly AgentMessage[];
      }
    >;
    "agent/text-delta": EmitEvent<
      AgentRunIdentity & { readonly text: string }
    >;
    "agent/thinking-delta": EmitEvent<
      AgentRunIdentity & { readonly thinking: string }
    >;
    "agent/tool-call-start": EmitEvent<
      AgentRunIdentity & { readonly id: string; readonly name: string }
    >;
    "agent/tool-call-delta": EmitEvent<
      AgentRunIdentity & { readonly id: string; readonly argumentsDelta: string }
    >;
    "agent/tool-call": EmitEvent<ToolCallEvent>;
    "agent/tool-result": EmitEvent<ToolResultEvent>;
  }
}
