import type { AgentMessage, AgentRunIdentity } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { EmitEvent, InterceptEvent } from "../events/types.js";

declare module "../events/types.js" {
  interface EventMap {
    // Events dispatched with intercept().
    "agent/user-prompt": InterceptEvent<
      AgentRunIdentity & { readonly prompt: string },
      string | undefined
    >;

    "agent/context": InterceptEvent<
      AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      readonly AgentMessage[]
    >;

    "agent/stopping": InterceptEvent<
      AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
      AgentMessage | undefined
    >;

    // Events dispatched with emit().
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

    "agent/tool-call": EmitEvent<
      AgentRunIdentity & { readonly call: AgentToolCall }
    >;

    "agent/tool-result": EmitEvent<
      AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult }
    >;
  }
}
