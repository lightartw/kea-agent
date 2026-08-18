import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { CliFrontend } from "./ui/cli-frontend.js";
import { openOrCreateProject } from "./coding-agent/factory.js";
import { createModelRuntimeFromEnvironment } from "./core/ai/factory.js";
import type { ModelConfig } from "./core/ai/types.js";

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    // Temporary compatibility until Task 9
    const runtime = createModelRuntimeFromEnvironment(process.env);
    const configured = ["ANTHROPIC", "OPENAI", "GEMINI"].filter(
      (name) => process.env[`${name}_API_KEY`],
    );
    const defaultProvider = process.env.DEFAULT_PROVIDER ??
      (configured.length === 1 ? configured[0]!.toLowerCase() : undefined);
    if (defaultProvider === undefined) {
      throw new Error(configured.length === 0
        ? "No LLM provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY"
        : "Multiple LLM providers configured; set DEFAULT_PROVIDER");
    }
    if (!configured.some((name) => name.toLowerCase() === defaultProvider)) {
      throw new Error(`DEFAULT_PROVIDER '${defaultProvider}' is not configured`);
    }
    const modelId = process.env.MODEL_ID;
    if (!modelId) throw new Error("Missing model; set MODEL_ID");
    const modelConfig: ModelConfig = { provider: defaultProvider, model: modelId };
    const keaHome = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
    const project = await openOrCreateProject({
      keaHome,
      runtime,
      modelConfig,
      interactions: cli.interactions,
      // Temporary compatibility until Task 9: flat runtime policy defaults.
      maxTurns: 20,
      toolTimeoutSeconds: 120,
    });
    const sessions = await project.listSessions();
    const harness = sessions[0] !== undefined
      ? await project.createHarnessFromSession(sessions[0].id)
      : await project.createHarness();
    await cli.run(project, harness);
  } finally {
    cli.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  void asyncMain().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
