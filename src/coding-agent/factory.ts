import { resolve } from "node:path";

import { AgentHarness } from "../harness/agent-harness.js";
import { SessionRepository } from "../harness/session/repository.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../harness/system-prompt.js";
import {
  createAgentToolRegistry,
  createBuiltinToolDefinitions,
} from "./tools/factory.js";
import { createCodingHooks } from "./hooks/factory.js";
import { NO_INTERACTIONS } from "./ui/interactions.js";
import { CodingToolPresentationRegistry } from "./ui/presentation.js";
import type { CodingToolDefinition } from "./tools/definition.js";
import type { Session } from "../harness/session/session.js";
import type { CodingAgent, CodingProject } from "./types.js";
import type { SystemPromptBuilder } from "../harness/types.js";
import type { CreateCodingAgentConfig } from "./types.js";
import type { CodingAgentInteractions } from "./ui/interactions.js";

function resolveSystemPrompt(
  prompt: string | SystemPromptBuilder | undefined,
): SystemPromptBuilder {
  if (typeof prompt === "function") return prompt;
  return defaultSystemPrompt(prompt ?? CODING_SYSTEM_PROMPT);
}

function createHarness(
  session: Session,
  config: CreateCodingAgentConfig,
  project: CodingProject,
  definitions: readonly CodingToolDefinition[],
  interactions: CodingAgentInteractions,
  systemPrompt: SystemPromptBuilder,
): AgentHarness {
  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: createAgentToolRegistry(definitions, { cwd: project.workDir }),
    systemPrompt,
    cwd: project.workDir,
    hooks: createCodingHooks(interactions),
    ...(config.onEventListenerError !== undefined
      ? { onEventListenerError: config.onEventListenerError }
      : {}),
  });
}

export async function createCodingAgent(
  config: CreateCodingAgentConfig,
): Promise<CodingAgent> {
  const project: CodingProject = {
    workDir: resolve(config.project.workDir),
    storageDir: resolve(config.project.storageDir),
  };
  const repository = new SessionRepository(project.storageDir);
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
  const bindSession = (session: Session) => createHarness(
    session,
    config,
    project,
    definitions,
    interactions,
    systemPrompt,
  );

  return {
    listSessions: () => repository.list(),
    createSession: async () => bindSession(await repository.create()),
    openSession: async (sessionId) => bindSession(await repository.open(sessionId)),
    continueRecent: async () => {
      const [sessionId] = await repository.list();
      return sessionId === undefined
        ? bindSession(await repository.create())
        : bindSession(await repository.open(sessionId));
    },
    renderToolEvent: (event) => presentations.render(event),
  };
}
