import type { EventContract } from "../events/types.js";
import type { AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

export interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly lane: string;
}

export type ToolCallDecision =
  | (AgentRunIdentity & { readonly kind: "execute"; readonly call: AgentToolCall })
  | (AgentRunIdentity & {
      readonly kind: "reject";
      readonly call: AgentToolCall;
      readonly reason: string;
    });

declare module "../events/types.js" {
  interface EventMap {
    "agent/user-prompt": EventContract<
      "ask",
      AgentRunIdentity & { readonly prompt: string },
      { readonly block: true; readonly reason?: string }
    >;
    "agent/context": EventContract<
      "transform",
      AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      AgentRunIdentity & { readonly messages: readonly AgentMessage[] }
    >;
    "agent/tool-call": EventContract<"transform", ToolCallDecision, ToolCallDecision>;
    "agent/tool-result": EventContract<
      "transform",
      AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult },
      AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult }
    >;
    "agent/stop": EventContract<
      "ask",
      AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      { readonly continueWith: AgentMessage }
    >;
  }
}
