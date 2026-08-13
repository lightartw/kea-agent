import type { HarnessProject, SystemPromptBuilder } from "../agent/harness/types.js";
import type { StreamFn, ModelConfig } from "../ai/types.js";
import type { Session } from "../agent/harness/session/session.js";
import type { CodingHookUI } from "./hooks/types.js";

export type {
  CodingHookContext,
  CodingHookUI,
  HookConfirmation,
  HookNotification,
} from "./hooks/types.js";

/** Configuration for creating a Coding Agent harness through the public factory. */
export interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly ui?: CodingHookUI;
}
