import type { AgentToolCall, AgentToolResult } from "./types.js";

declare module "../../events/types.js" {
  interface EventMap {
    "tools/pre-execute"(
      call: AgentToolCall,
      proceed: (
        call: AgentToolCall,
      ) => Promise<AgentToolCall | AgentToolResult>,
      signal?: AbortSignal,
    ): AgentToolCall | AgentToolResult | Promise<AgentToolCall | AgentToolResult>;

    "tools/execute"(
      call: AgentToolCall,
      proceed: (call: AgentToolCall) => Promise<AgentToolResult>,
      signal?: AbortSignal,
    ): AgentToolResult | Promise<AgentToolResult>;

    "tools/post-execute"(
      input: { readonly call: AgentToolCall; readonly result: AgentToolResult },
      proceed: (
        input: { readonly call: AgentToolCall; readonly result: AgentToolResult },
      ) => Promise<AgentToolResult>,
      signal?: AbortSignal,
    ): AgentToolResult | Promise<AgentToolResult>;
  }
}
