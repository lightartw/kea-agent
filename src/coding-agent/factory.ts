import { resolve } from "node:path";

import { AgentHarness } from "../harness/agent-harness.js";
import { SessionRepository } from "../harness/session/repository.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../harness/system-prompt.js";
import {
  createEditFileToolDefinition,
  createGlobToolDefinition,
  createReadFileToolDefinition,
  createWriteFileToolDefinition,
} from "./tools/builtin/files.js";
import { createBashToolDefinition } from "./tools/builtin/bash.js";
import { createTodoWriteToolDefinition } from "./tools/builtin/todo.js";
import { toAgentTool } from "./tools/definition.js";
import { createPermissionHooks } from "./hooks/permission.js";
import { NO_INTERACTIONS } from "./ui/interactions.js";
import { CodingToolPresentationRegistry } from "./ui/presentation.js";
import type {
  CodingToolContext,
  CodingToolDefinition,
} from "./tools/definition.js";
import type { Session } from "../harness/session/session.js";
import type { CodingAgent, CodingProject } from "./types.js";
import type { SystemPromptBuilder } from "../harness/types.js";
import type { CreateCodingAgentConfig } from "./types.js";

function resolveSystemPrompt(
  prompt: string | SystemPromptBuilder | undefined,
): SystemPromptBuilder {
  if (typeof prompt === "function") return prompt;
  return defaultSystemPrompt(prompt ?? CODING_SYSTEM_PROMPT);
}

export async function createCodingAgent(
  config: CreateCodingAgentConfig,
): Promise<CodingAgent> {
  const project: CodingProject = {
    workDir: resolve(config.project.workDir),
    storageDir: resolve(config.project.storageDir),
  };
  const repository = new SessionRepository(project.storageDir);
  const context: CodingToolContext = { cwd: project.workDir };
  const interactions = config.interactions ?? NO_INTERACTIONS;
  const definitions: readonly CodingToolDefinition[] = [
    createBashToolDefinition(),
    createReadFileToolDefinition(),
    createWriteFileToolDefinition(),
    createEditFileToolDefinition(),
    createGlobToolDefinition(),
    createTodoWriteToolDefinition(),
  ];
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

  function createHarness(session: Session): AgentHarness {
    const tools = new AgentToolRegistry();
    for (const definition of definitions) {
      tools.register(toAgentTool(definition, context));
    }

    return new AgentHarness({
      session,
      model: config.model,
      streamFn: config.streamFn,
      toolRegistry: tools,
      systemPrompt,
      cwd: project.workDir,
      hooks: createPermissionHooks(interactions),
      ...(config.onEventListenerError !== undefined
        ? { onEventListenerError: config.onEventListenerError }
        : {}),
    });
  }

  return {
    listSessions: () => repository.list(),
    createSession: async () => createHarness(await repository.create()),
    openSession: async (sessionId) => createHarness(await repository.open(sessionId)),
    continueRecent: async () => {
      const [sessionId] = await repository.list();
      return sessionId === undefined
        ? createHarness(await repository.create())
        : createHarness(await repository.open(sessionId));
    },
    renderToolEvent: (event) => presentations.render(event),
  };
}
