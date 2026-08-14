import type { AgentRunIdentity } from "../agent/events.js";

export const MAIN_LANE = "main";

declare module "../events/types.js" {
  interface EventMap {
    "harness/run-start": (
      input: AgentRunIdentity,
    ) => void | Promise<void>;

    "harness/run-end": (
      input: AgentRunIdentity & (
        | { readonly reason: "completed" | "aborted" }
        | { readonly reason: "error"; readonly errorMessage: string }
      ),
    ) => void | Promise<void>;
  }
}
