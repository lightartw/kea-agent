import type { AgentEvent } from "../types.js";
import type { AgentTool } from "../tools/types.js";
import type { AgentToolRegistry } from "../tools/registry.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { ModelConfig, StreamFn } from "../../ai/types.js";
import type { Session } from "./session/session.js";

export type HarnessEventListener = (
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
  readonly hooks?: HookRegistry;
}

export interface HarnessProject {
  readonly workDir: string;
  readonly storageDir: string;
}

export interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
}
