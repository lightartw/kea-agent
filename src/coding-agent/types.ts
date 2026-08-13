import type { HarnessProject, SystemPromptBuilder } from "../harness/types.js";
import type { HarnessListenerErrorHandler } from "../harness/events/types.js";
import type { StreamFn, ModelConfig } from "../ai/types.js";
import type { Session } from "../harness/session/session.js";
import type { CodingAgentInteractions } from "./ui/interactions/types.js";

export type { CodingHookContext } from "./hooks/types.js";

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
