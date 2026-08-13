import type { HarnessProject, SystemPromptBuilder } from "../harness/types.js";
import type { HarnessListenerErrorHandler } from "../harness/events/types.js";
import type { StreamFn, ModelConfig } from "../ai/types.js";
import type { Session } from "../harness/session/session.js";
import type { AgentHarness } from "../harness/agent-harness.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";
import type { HarnessToolEvent } from "../harness/events/types.js";

/** Configuration for creating a Coding Agent runtime through the public factory. */
export interface CreateCodingAgentConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

/** The capabilities assembled and returned by createCodingAgent(). */
export interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly renderToolEvent: (event: HarnessToolEvent) => string;
}
