import type { AgentEvent } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { AgentToolRegistry } from "../agent/tools/registry.js";
import type { AgentHookTrigger } from "../agent/hooks/types.js";
import type { ModelConfig, StreamFn } from "../ai/types.js";
import type { Session } from "./session/session.js";

export type HarnessListener = (
  event: AgentEvent,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

export type SystemPromptBuilder = (
  context: SystemPromptContext,
) => string | Promise<string>;

export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
  readonly hooks?: AgentHookTrigger;
}

export interface HarnessProject {
  readonly workDir: string;
  readonly storageDir: string;
}
