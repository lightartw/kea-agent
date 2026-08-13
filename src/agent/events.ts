import type { EventContract } from "../events/types.js";
import type { AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

export interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly lane: string;
}

export type ToolRejectedReason = "blocked" | "invalid" | "unknown" | "aborted";

export type ToolCallDecision =
  | (AgentRunIdentity & { readonly kind: "execute"; readonly call: AgentToolCall })
  | (AgentRunIdentity & {
      readonly kind: "reject";
      readonly call: AgentToolCall;
      readonly reason: string;
    });

declare module "../events/types.js" {
  interface EventMap {
    // Control questions and transformations.
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

    // Facts published during one Run.
    "agent/turn-start": EventContract<"emit", AgentRunIdentity>;
    "agent/turn-end": EventContract<"emit", AgentRunIdentity & { readonly message: AgentMessage }>;
    "agent/text-delta": EventContract<"emit", AgentRunIdentity & { readonly text: string }>;
    "agent/thinking-delta": EventContract<"emit", AgentRunIdentity & { readonly thinking: string }>;
    "agent/toolcall-start": EventContract<"emit", AgentRunIdentity & { readonly id: string; readonly name: string }>;
    "agent/toolcall-delta": EventContract<"emit", AgentRunIdentity & { readonly id: string; readonly argumentsDelta: string }>;
    "agent/toolcall-end": EventContract<"emit", AgentRunIdentity & { readonly toolCall: AgentToolCall }>;
    "agent/tool-start": EventContract<"emit", AgentRunIdentity & { readonly call: AgentToolCall }>;
    "agent/tool-end": EventContract<"emit", AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult }>;
    "agent/tool-rejected": EventContract<"emit", AgentRunIdentity & {
      readonly call: AgentToolCall;
      readonly effectiveArguments?: Readonly<Record<string, unknown>>;
      readonly result: AgentToolResult;
      readonly reason: ToolRejectedReason;
    }>;
  }
}
