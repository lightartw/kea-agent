import { relative, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { AgentHarness } from "../harness/agent-harness.js";
import { SessionRepository } from "../harness/session/repository.js";
import type { Session } from "../harness/session/session.js";
import type { SessionInfo } from "../harness/session/types.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../harness/system-prompt.js";
import {
  createAgentToolRegistry,
  createBuiltinToolDefinitions,
} from "./tools/factory.js";
import { createCodingHooks } from "./hooks/factory.js";
import { NO_INTERACTIONS } from "./ui/interactions.js";
import { CodingToolPresentationRegistry } from "./ui/presentation.js";
import {
  applyProjectUpdate,
  assertDirectoryOwnership,
  openOrCreateProject,
  persistProject,
} from "./project/storage.js";
import type { CodingToolContext, CodingToolDefinition } from "./tools/definition.js";
import type {
  CreateSessionOptions,
  OpenedProject,
  Project,
  ProjectInfo,
  UpdateProjectInput,
} from "./project/types.js";
import type { SystemPromptBuilder } from "../harness/types.js";
import type { CreateProjectConfig } from "./types.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";

function resolveSystemPrompt(
  prompt: string | SystemPromptBuilder | undefined,
): SystemPromptBuilder {
  if (typeof prompt === "function") return prompt;
  return defaultSystemPrompt(prompt ?? CODING_SYSTEM_PROMPT);
}

function isInside(path: string, directory: string): boolean {
  const normalized = resolve(directory);
  return path === normalized || path.startsWith(normalized + "\\") ||
    path.startsWith(normalized + "/");
}

function relativeCwd(directory: string, absolutePath: string): string {
  const rel = relative(resolve(directory), resolve(absolutePath));
  return rel === "" ? "." : rel.replaceAll("\\", "/");
}

function selectContainingDirectory(
  directories: readonly string[],
  absolutePath: string,
): string {
  let best: string | undefined;
  for (const directory of directories) {
    const normalized = resolve(directory);
    if (isInside(absolutePath, normalized) && (best === undefined || normalized.length > best.length)) {
      best = normalized;
    }
  }
  if (best === undefined) {
    throw new Error("Cwd escapes the Project directories");
  }
  return best;
}

function createHarness(
  session: Session,
  config: CreateProjectConfig,
  definitions: readonly CodingToolDefinition[],
  interactions: CodingAgentInteractions,
  systemPrompt: SystemPromptBuilder,
): AgentHarness {
  const toolContext: CodingToolContext = {
    cwd: resolve(session.info.directory, session.info.cwd),
  };
  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: createAgentToolRegistry(definitions, toolContext),
    systemPrompt,
    cwd: toolContext.cwd,
    hooks: createCodingHooks(interactions),
    ...(config.onEventListenerError !== undefined
      ? { onEventListenerError: config.onEventListenerError }
      : {}),
  });
}

export async function createProject(config: CreateProjectConfig): Promise<Project> {
  const opened: OpenedProject = await openOrCreateProject({
    keaHome: config.keaHome,
    ...(config.directory !== undefined ? { directory: config.directory } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  });

  const repository = new SessionRepository(opened.storageDir);
  const interactions = config.interactions ?? NO_INTERACTIONS;
  const definitions = createBuiltinToolDefinitions();
  const presentations = new CodingToolPresentationRegistry(
    (message) => {
      try {
        void Promise.resolve(interactions.notify({
          source: "tool-presentation",
          level: "error",
          message,
        })).catch(() => undefined);
      } catch {
        // Presentation diagnostics must not re-enter execution.
      }
    },
  );

  for (const definition of definitions) {
    if (definition.presentation !== undefined) {
      presentations.register(definition.name, definition.presentation);
    }
  }

  const systemPrompt = resolveSystemPrompt(config.systemPrompt);
  let current: ProjectInfo = opened.info;
  const initialCwd = opened.initialCwd;

  const bindSession = (session: Session) => createHarness(
    session,
    config,
    definitions,
    interactions,
    systemPrompt,
  );

  const createSessionCwd = (options?: CreateSessionOptions): string => {
    if (options?.cwd === undefined) return ".";
    const absolute = resolve(current.primaryDirectory, options.cwd);
    const containing = selectContainingDirectory(current.directories, absolute);
    return relativeCwd(containing, absolute);
  };

  return {
    ...current,
    listSessions: async (): Promise<readonly SessionInfo[]> => repository.list(),
    createSession: async (options?: CreateSessionOptions) =>
      bindSession(await repository.create({
        projectId: current.id,
        directory: current.primaryDirectory,
        cwd: createSessionCwd(options),
      })),
    openSession: async (sessionId) => {
      const session = await repository.open(sessionId);
      if (session.info.projectId !== current.id) {
        throw new Error("Session belongs to a different Project");
      }
      if (!current.directories.includes(session.info.directory)) {
        throw new Error("Session directory is not registered to this Project");
      }
      const resolvedCwd = resolve(session.info.directory, session.info.cwd);
      const stats = await stat(resolvedCwd).catch(() => undefined);
      if (stats === undefined || !stats.isDirectory()) {
        throw new Error(`Session cwd does not exist: ${resolvedCwd}`);
      }
      return bindSession(session);
    },
    continueRecent: async () => {
      const [latest] = await repository.list();
      if (latest !== undefined) return bindSession(await repository.open(latest.id));
      return bindSession(await repository.create({
        projectId: current.id,
        directory: current.primaryDirectory,
        cwd: relativeCwd(current.primaryDirectory, initialCwd),
      }));
    },
    update: async (input: UpdateProjectInput): Promise<ProjectInfo> => {
      const next = applyProjectUpdate(current, input);
      await assertDirectoryOwnership(config.keaHome, current.id, next.directories);
      await persistProject(config.keaHome, next);
      current = next;
      return next;
    },
    renderToolEvent: (event) => presentations.render(event),
  };
}
