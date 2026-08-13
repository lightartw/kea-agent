import type { ModelConfig, StreamFn } from "../ai/types.js";
import type { EventListenerErrorHandler } from "../events/types.js";
import type { SystemPromptBuilder } from "../harness/types.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";

export interface CreateProjectConfig {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: EventListenerErrorHandler;
}
