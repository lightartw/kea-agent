import type { EventContract } from "../events/types.js";
import type { AgentRunIdentity } from "../agent/events.js";

export const MAIN_LANE = "main";

export type HarnessRunEndInput = AgentRunIdentity & (
  | { readonly reason: "completed" | "aborted" }
  | { readonly reason: "error"; readonly errorMessage: string }
);

declare module "../events/types.js" {
  interface EventMap {
    "harness/run-start": EventContract<"emit", AgentRunIdentity>;
    "harness/run-end": EventContract<"emit", HarnessRunEndInput>;
  }
}
