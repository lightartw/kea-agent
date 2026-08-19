#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./coding-agent/cli/args.js";
import { resolveProjectDirectory } from "./coding-agent/cli/project-directory.js";
import { loadConfig } from "./coding-agent/config/config.js";
import { openOrCreateProject } from "./coding-agent/factory.js";
import type { Project } from "./coding-agent/index.js";
import { createModelRuntime } from "./core/ai/factory.js";
import type { AgentHarness } from "./core/harness/index.js";
import { CliUi } from "./ui/cli/index.js";

/**
 * Initial Harness for the prompt loop: `kea -c` resumes the newest Session,
 * plain `kea` always starts a fresh one. A failed Session restore surfaces to
 * the caller; the UI never runs without an initial Harness.
 */
export async function selectInitialHarness(
  project: Project,
  continueFlag: boolean,
): Promise<AgentHarness> {
  if (continueFlag) {
    const sessions = await project.listSessions();
    const newest = sessions[0];
    if (newest !== undefined) {
      return project.createHarnessFromSession(newest.id);
    }
  }
  return project.createHarness();
}

/** Production composition root; never runs on import. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.diagnostics.some((d) => d.type === "error")) {
    for (const d of args.diagnostics) {
      console.error(`${d.type}: ${d.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const projectDirectory = await resolveProjectDirectory(args.directory);
  const { config, keaHome } = await loadConfig({
    projectDirectory,
    ...(args.config === undefined ? {} : { configOverride: args.config }),
    verbose: args.verbose,
  });

  const reportError = (error: unknown): void => {
    console.error(config.redact(error instanceof Error ? error.message : String(error)));
  };

  if (config.verbose) {
    reportError(`project directory: ${projectDirectory}`);
    for (const model of config.models) {
      reportError(`model: ${model.provider}/${model.model}`);
    }
    for (const provider of config.runtimeProviders()) {
      reportError(
        `credentials: ${provider.name} ${provider.apiKey === "" ? "missing" : "configured"}`,
      );
    }
  }

  const runtime = createModelRuntime({ providers: config.runtimeProviders() });
  const ui = new CliUi({
    models: config.models,
    thinking: config.thinking,
    toolDetails: config.toolDetails,
    reportError,
  });
  const project = await openOrCreateProject({
    keaHome,
    projectDirectory,
    runtime,
    modelConfig: config.defaultModel,
    interaction: ui.interactions,
    maxTurns: config.maxTurns,
    toolTimeoutSeconds: config.toolTimeoutSeconds,
  });
  const initial = await selectInitialHarness(project, args.continue);

  try {
    await ui.run(project, initial);
  } finally {
    ui.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
