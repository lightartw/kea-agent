import type { ModelConfig, StreamFn } from "../ai/types.js";
import type { AgentHarness } from "../harness/agent-harness.js";
import type {
  HarnessListenerErrorHandler,
  HarnessToolEvent,
} from "../harness/events/types.js";
import type { SystemPromptBuilder } from "../harness/types.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";

export interface CodingProject {
  readonly workDir: string;
  readonly storageDir: string;
}

export interface CreateCodingAgentConfig {
  readonly project: CodingProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

export interface CodingAgent {
  listSessions(): Promise<readonly string[]>;
  createSession(): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  renderToolEvent(event: HarnessToolEvent): string;
}
