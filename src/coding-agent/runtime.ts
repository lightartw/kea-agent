import type { AgentHarness } from "../harness/agent-harness.js";
import type { CodingToolPresentationRegistry } from "./ui/presentation/registry.js";

export interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}
