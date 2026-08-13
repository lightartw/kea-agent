import { resolve } from "node:path";

import { AgentHarness } from "../harness/agent-harness.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../harness/system-prompt.js";
import {
  createEditFileToolDefinition,
  createReadFileToolDefinition,
  createWriteFileToolDefinition,
} from "./tools/builtin/files.js";
import { createBashToolDefinition } from "./tools/builtin/bash/definition.js";
import { createGlobToolDefinition } from "./tools/builtin/glob.js";
import { createTodoWriteToolDefinition } from "./tools/builtin/todo/definition.js";
import { toAgentTool } from "./tools/definition.js";
import { createPermissionHooks } from "./hooks/permission.js";
import { NO_INTERACTIONS } from "./ui/interactions.js";
import { CodingToolPresentationRegistry } from "./ui/presentation/registry.js";
import type {
  CodingToolContext,
  CodingToolDefinition,
} from "./tools/definition.js";
import type { CodingAgentRuntime } from "./types.js";
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
): Promise<CodingAgentRuntime> {
  if (!config.session) throw new Error("session is required");

  const context: CodingToolContext = { cwd: resolve(config.project.workDir) };
  const interactions = config.interactions ?? NO_INTERACTIONS;
  const definitions: readonly CodingToolDefinition[] = [
    createBashToolDefinition(),
    createReadFileToolDefinition(),
    createWriteFileToolDefinition(),
    createEditFileToolDefinition(),
    createGlobToolDefinition(),
    createTodoWriteToolDefinition(),
  ];
  const tools = new AgentToolRegistry();
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
    tools.register(toAgentTool(definition, context));
    if (definition.presentation !== undefined) {
      presentations.register(definition.name, definition.presentation);
    }
  }

  const hooks = createPermissionHooks({
    cwd: context.cwd,
    interactions,
  });
  const harness = new AgentHarness({
    session: config.session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: tools,
    systemPrompt: resolveSystemPrompt(config.systemPrompt),
    cwd: context.cwd,
    hooks,
    ...(config.onEventListenerError !== undefined
      ? { onEventListenerError: config.onEventListenerError }
      : {}),
  });
  return { harness, presentations };
}
