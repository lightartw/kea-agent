import { AgentHarness } from "./agent-harness.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { Session } from "./session/session.js";
import { defaultSystemPrompt } from "./system-prompt.js";
import { createToolRegistry } from "./tools/factory.js";
import type {
  CreateHarnessConfig,
  SystemPromptBuilder,
} from "./types.js";

function resolveSystemPrompt(
  prompt: string | SystemPromptBuilder | undefined,
): SystemPromptBuilder {
  if (typeof prompt === "function") return prompt;
  return defaultSystemPrompt(prompt ?? CODING_SYSTEM_PROMPT);
}

export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness> {
  const session =
    config.session ??
    await Session.create(config.project.storageDir);

  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: createToolRegistry(config.project.workDir),
    systemPrompt: resolveSystemPrompt(config.systemPrompt),
    cwd: config.project.workDir,
  });
}
