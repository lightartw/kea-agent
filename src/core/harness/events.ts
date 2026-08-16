import type { AgentRunIdentity } from "../agent/types.js";
import type { EmitEvent } from "../events/types.js";

export type HarnessRunEnd = AgentRunIdentity & (
  | { readonly reason: "completed" | "aborted" }
  | { readonly reason: "error"; readonly errorMessage: string }
);

declare module "../events/types.js" {
  interface EventMap {
    "harness/run-start": EmitEvent<AgentRunIdentity>;
    "harness/run-end": EmitEvent<HarnessRunEnd>;
  }
}
