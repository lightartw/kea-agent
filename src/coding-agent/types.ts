import type { ModelConfig, ModelRuntime } from "../core/ai/types.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";

export interface CreateProjectConfig {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly systemPrompt?: string;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}
