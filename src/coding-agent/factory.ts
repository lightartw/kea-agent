import { AgentHarness } from "../harness/agent-harness.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../harness/system-prompt.js";
import { createDefaultToolDefinitions } from "./tools/factory.js";
import { toAgentTool } from "./tools/wrapper.js";
import { createCodingHookRegistry } from "./hooks/factory.js";
import { NO_INTERACTIONS } from "./ui/interactions.js";
import type { SystemPromptBuilder } from "../harness/types.js";
import type { CreateHarnessConfig } from "./types.js";

function resolveSystemPrompt(
  prompt: string | SystemPromptBuilder | undefined,
): SystemPromptBuilder {
  if (typeof prompt === "function") return prompt;
  return defaultSystemPrompt(prompt ?? CODING_SYSTEM_PROMPT);
}

export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness> {
  if (!config.session) throw new Error("session is required");
  const session = config.session;

  const context = { cwd: config.project.workDir };
  const tools = new AgentToolRegistry();
  for (const definition of createDefaultToolDefinitions()) {
    tools.register(toAgentTool(definition, context));
  }

  const hooks = createCodingHookRegistry({
    cwd: context.cwd,
    interactions: config.interactions ?? NO_INTERACTIONS,
  });

  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: tools,
    systemPrompt: resolveSystemPrompt(config.systemPrompt),
    cwd: context.cwd,
    hooks,
  });
}
