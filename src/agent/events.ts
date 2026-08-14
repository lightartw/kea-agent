import type { AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

export interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly lane: string;
}

declare module "../events/types.js" {
  interface EventMap {
    // Control interceptors.
    "agent/user-prompt"(
      input: AgentRunIdentity & { readonly prompt: string },
      proceed: (
        input: AgentRunIdentity & { readonly prompt: string },
      ) => Promise<string | undefined>,
      signal?: AbortSignal,
    ): string | undefined | Promise<string | undefined>;

    "agent/context"(
      input: AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      proceed: (
        input: AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      ) => Promise<readonly AgentMessage[]>,
      signal?: AbortSignal,
    ): readonly AgentMessage[] | Promise<readonly AgentMessage[]>;

    "agent/stopping"(
      input: AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      proceed: (
        input: AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      ) => Promise<AgentMessage | undefined>,
      signal?: AbortSignal,
    ): AgentMessage | undefined | Promise<AgentMessage | undefined>;

    // Facts published during one Run.
    "agent/turn-start"(
      input: AgentRunIdentity,
    ): void | Promise<void>;

    "agent/turn-end"(
      input: AgentRunIdentity & {
        readonly message: AgentMessage;
        readonly toolResults: readonly AgentMessage[];
      },
    ): void | Promise<void>;

    "agent/text-delta"(
      input: AgentRunIdentity & { readonly text: string },
    ): void | Promise<void>;

    "agent/thinking-delta"(
      input: AgentRunIdentity & { readonly thinking: string },
    ): void | Promise<void>;

    "agent/tool-call-start"(
      input: AgentRunIdentity & { readonly id: string; readonly name: string },
    ): void | Promise<void>;

    "agent/tool-call-delta"(
      input: AgentRunIdentity & { readonly id: string; readonly argumentsDelta: string },
    ): void | Promise<void>;

    "agent/tool-call"(
      input: AgentRunIdentity & { readonly call: AgentToolCall },
    ): void | Promise<void>;

    "agent/tool-result"(
      input: AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult },
    ): void | Promise<void>;
  }
}
