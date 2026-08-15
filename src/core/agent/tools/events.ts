import type { AgentToolCall, AgentToolResult } from "./types.js";
import type { InterceptEvent } from "../../events/types.js";

export type PreToolDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason?: string };

declare module "../../events/types.js" {
  interface EventMap {
    "tools/pre-execute": InterceptEvent<
      AgentToolCall,
      PreToolDecision
    >;

    "tools/execute": InterceptEvent<AgentToolCall, AgentToolResult>;

    "tools/post-execute": InterceptEvent<
      { readonly call: AgentToolCall; readonly result: AgentToolResult },
      AgentToolResult
    >;
  }
}
