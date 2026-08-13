import { resolve } from "node:path";

import { AgentHarness } from "../harness/agent-harness.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../harness/system-prompt.js";
import { createDefaultToolDefinitions } from "./tools/builtin/factory.js";
import { toAgentTool } from "./tools/wrapper.js";
import { createDefaultCodingHookRegistry } from "./hooks/builtin/factory.js";
import { NO_INTERACTIONS } from "./ui/interactions/unavailable.js";
import { CodingToolPresentationRegistry } from "./ui/presentation/registry.js";
import type { CodingToolContext } from "./tools/definition.js";
import type { CodingAgentRuntime } from "./runtime.js";
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
  const definitions = createDefaultToolDefinitions();
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

  const hooks = createDefaultCodingHookRegistry({
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
