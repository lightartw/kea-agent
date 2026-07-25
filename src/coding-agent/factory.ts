import { AgentHarness } from "../agent/harness/agent-harness.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { defaultSystemPrompt } from "../agent/harness/system-prompt.js";
import { createToolRegistry } from "./tools/factory.js";
import type {
  CreateHarnessConfig,
  SystemPromptBuilder,
} from "../agent/harness/types.js";

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

  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: createToolRegistry(config.project.workDir),
    systemPrompt: resolveSystemPrompt(config.systemPrompt),
    cwd: config.project.workDir,
  });
}
