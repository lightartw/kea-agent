import type { AgentHarness } from "../../core/harness/agent-harness.js";
import type { Events } from "../../core/events/events.js";
import type { ToolPresentationInput } from "../ui/presentation.js";
import type { SessionMetadata } from "../../core/harness/session/types.js";

export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directories: readonly string[];
  readonly primaryDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly directories?: readonly string[];
  readonly primaryDirectory?: string;
}

export interface OpenProjectInput {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
}

export interface OpenedProject {
  readonly info: ProjectInfo;
  readonly storageDir: string;
  readonly initialCwd: string;
}

export interface CreateSessionOptions {
  readonly cwd?: string;
}

export interface Project extends ProjectInfo {
  readonly events: Events;
  listSessions(): Promise<readonly SessionMetadata[]>;
  createSession(options?: CreateSessionOptions): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  update(input: UpdateProjectInput): Promise<ProjectInfo>;
  renderTool(input: ToolPresentationInput): string;
}
