import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// Include Agent's EventMap augmentation when Project is compiled in isolation.
import type {} from "../../core/agent/events.js";
import type { ModelConfig, ModelRuntime } from "../../core/ai/types.js";
import type { Events } from "../../core/events/events.js";
import { AgentHarness } from "../../core/harness/agent-harness.js";
import { SessionRepository } from "../../core/harness/session/repository.js";
import type { Session } from "../../core/harness/session/session.js";
import type { SessionMetadata } from "../../core/harness/session/types.js";
import { createSystemPrompt } from "../system-prompt.js";
import { createBuiltinToolRegistry } from "../tools/factory.js";

/** One durable Project record: identity plus the normalized Project directory. */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ProjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectError";
  }
}

/** Strict UUID shape shared by Project ID scanning, validation, and path derivation. */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_ISO_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Shared field validation for ProjectInfo values from any source. */
export function validateProjectInfo(info: ProjectInfo): void {
  if (typeof info.id !== "string" || !PROJECT_ID_PATTERN.test(info.id)) {
    throw new ProjectError(`Project ID is invalid: ${info.id}`);
  }
  if (typeof info.name !== "string" || info.name.trim() === "") {
    throw new ProjectError("Project name must be a non-empty string");
  }
  if (
    typeof info.directory !== "string"
    || !isAbsolute(info.directory)
    || resolve(info.directory) !== info.directory
  ) {
    throw new ProjectError(`Project directory must be absolute and normalized: ${info.directory}`);
  }
  if (!isUtcTimestamp(info.createdAt)) {
    throw new ProjectError(`Project createdAt is not a valid UTC timestamp: ${info.createdAt}`);
  }
  if (!isUtcTimestamp(info.updatedAt)) {
    throw new ProjectError(`Project updatedAt is not a valid UTC timestamp: ${info.updatedAt}`);
  }
}

/**
 * The runtime aggregate for one Project. Owns Session lifecycle and Harness
 * construction; it never retains ProjectStorage or keaHome and has no
 * update/save/delete operation.
 */
export class Project {
  /** Project-scoped Events bus; Harnesses observe it through subscribe(). */
  private readonly events: Events;

  private readonly infoState: ProjectInfo;
  private readonly projectDirectory: string;
  private readonly sessions: SessionRepository;
  private readonly runtime: ModelRuntime;
  private readonly modelConfig: ModelConfig;
  private readonly maxTurns: number;
  private readonly toolTimeoutSeconds: number;

  constructor(options: {
    readonly info: ProjectInfo;
    readonly sessions: SessionRepository;
    readonly runtime: ModelRuntime;
    readonly modelConfig: ModelConfig;
    readonly maxTurns: number;
    readonly toolTimeoutSeconds: number;
    readonly events: Events;
  }) {
    validateProjectInfo(options.info);
    this.infoState = {
      id: options.info.id,
      name: options.info.name,
      directory: options.info.directory,
      createdAt: options.info.createdAt,
      updatedAt: options.info.updatedAt,
    };
    this.projectDirectory = this.infoState.directory;
    this.sessions = options.sessions;
    this.runtime = options.runtime;
    this.modelConfig = options.modelConfig;
    this.maxTurns = options.maxTurns;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.events = options.events;
  }

  get info(): ProjectInfo {
    return { ...this.infoState };
  }

  listSessions(): Promise<readonly SessionMetadata[]> {
    return this.sessions.list();
  }

  async createHarness(options?: { readonly cwd?: string }): Promise<AgentHarness> {
    const cwd = await this.resolveSessionCwd(options?.cwd ?? this.projectDirectory);
    const session = await this.sessions.create({ cwd });
    return this.buildHarness(session);
  }

  async createHarnessFromSession(sessionId: string): Promise<AgentHarness> {
    const session = await this.sessions.open(sessionId);
    await this.resolveSessionCwd(session.metadata.cwd);
    return this.buildHarness(session);
  }

  private async resolveSessionCwd(cwd: string): Promise<string> {
    const candidate = isAbsolute(cwd) ? cwd : resolve(this.projectDirectory, cwd);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (error) {
      throw new ProjectError(`Session working directory does not exist: ${candidate}`, {
        cause: error,
      });
    }
    const info = await stat(real);
    if (!info.isDirectory()) {
      throw new ProjectError(`Session working directory is not a directory: ${real}`);
    }
    return real;
  }

  private buildHarness(session: Session): AgentHarness {
    const cwd = session.metadata.cwd;
    return new AgentHarness({
      session,
      runtime: this.runtime,
      modelConfig: this.modelConfig,
      maxTurns: this.maxTurns,
      toolRegistry: createBuiltinToolRegistry(cwd, this.toolTimeoutSeconds),
      systemPrompt: createSystemPrompt(this.projectDirectory, cwd),
      events: this.events,
    });
  }
}
