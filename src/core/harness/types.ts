import type { AgentToolRegistry } from "../agent/tools/registry.js";
import type { Events } from "../events/events.js";
import type { ModelConfig, ModelRuntime } from "../ai/types.js";
import type { Session } from "./session/session.js";

export interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: Events;
}
