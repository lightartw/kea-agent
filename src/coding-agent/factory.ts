import { resolve } from "node:path";
import { stat } from "node:fs/promises";

import { AgentHarness } from "../core/harness/agent-harness.js";
import { SessionRepository } from "../core/harness/session/repository.js";
import type { Session } from "../core/harness/session/session.js";
import type { SessionMetadata } from "../core/harness/session/types.js";
import { Events } from "../core/events/events.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import {
  createAgentToolRegistry,
  createBuiltinToolDefinitions,
} from "./tools/factory.js";
import { registerCodingEvents } from "./events/factory.js";
import { NO_INTERACTIONS } from "./ui/interactions.js";
import { CodingToolPresentationRegistry } from "./ui/presentation.js";
import {
  applyProjectUpdate,
  assertDirectoryOwnership,
  openOrCreateProject,
  persistProject,
} from "./project/storage.js";
import type { CodingToolContext, ToolDefinition } from "./tools/definition.js";
import type {
  CreateSessionOptions,
  OpenedProject,
  Project,
  ProjectInfo,
  UpdateProjectInput,
} from "./project/types.js";
import type { CreateProjectConfig } from "./types.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";

function formatSystemPrompt(template: string, cwd: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return template
    .replace(/\{\{cwd\}\}/g, cwd)
    .replace(/\{\{date\}\}/g, `${yyyy}-${mm}-${dd}`);
}

function isInside(path: string, directory: string): boolean {
  const normalized = resolve(directory);
  return path === normalized || path.startsWith(normalized + "\\") ||
    path.startsWith(normalized + "/");
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
  definitions: readonly ToolDefinition[],
  directories: readonly string[],
  events: Events,
): AgentHarness {
  const toolContext: CodingToolContext = {
    cwd: session.metadata.cwd,
    directories,
  };
  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: createAgentToolRegistry(definitions, toolContext),
    systemPrompt: formatSystemPrompt(
      config.systemPrompt ?? CODING_SYSTEM_PROMPT,
      session.metadata.cwd,
      new Date(),
    ),
    events,
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
  const events = new Events(config.onEventListenerError);
  registerCodingEvents(events, interactions);
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

  let current: ProjectInfo = opened.info;
  const initialCwd = opened.initialCwd;

  const bindSession = (session: Session) => createHarness(
    session,
    config,
    definitions,
    current.directories,
    events,
  );

  const createSessionCwd = (options?: CreateSessionOptions): string => {
    const cwd = resolve(current.primaryDirectory, options?.cwd ?? ".");
    selectContainingDirectory(current.directories, cwd);
    return cwd;
  };

  return {
    ...current,
    events,
    listSessions: async (): Promise<readonly SessionMetadata[]> => repository.list(),
    createSession: async (options?: CreateSessionOptions) =>
      bindSession(await repository.create({ cwd: createSessionCwd(options) })),
    openSession: async (sessionId) => {
      const session = await repository.open(sessionId);
      const stats = await stat(session.metadata.cwd).catch(() => undefined);
      if (stats === undefined || !stats.isDirectory()) {
        throw new Error(`Session cwd does not exist: ${session.metadata.cwd}`);
      }
      selectContainingDirectory(current.directories, session.metadata.cwd);
      return bindSession(session);
    },
    continueRecent: async () => {
      const [latest] = await repository.list();
      if (latest !== undefined) return bindSession(await repository.open(latest.id));
      return bindSession(await repository.create({ cwd: initialCwd }));
    },
    update: async (input: UpdateProjectInput): Promise<ProjectInfo> => {
      const next = applyProjectUpdate(current, input);
      await assertDirectoryOwnership(config.keaHome, current.id, next.directories);
      await persistProject(config.keaHome, next);
      current = next;
      return next;
    },
    renderTool: (input) => presentations.render(input),
  };
}
