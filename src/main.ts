import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArguments } from "./application/arguments.js";
import { Config } from "./application/config.js";
import { initializeUserConfiguration } from "./application/init.js";
import { resolveProjectDirectory } from "./application/project-directory.js";
import { openOrCreateProject } from "./coding-agent/factory.js";
import type { Project } from "./coding-agent/index.js";
import { createModelRuntime } from "./core/ai/factory.js";
import type { AgentHarness } from "./core/harness/index.js";
import { CliUi } from "./ui/cli/index.js";

/** Redacted diagnostic path; identity until a Config exists to redact with. */
let writeDiagnostic = (message: string): void => {
  console.error(message);
};

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
  const args = parseArguments(argv);
  const keaHome = resolve(homedir(), ".kea");
  if (args.command === "init") {
    const { config, auth } = await initializeUserConfiguration(keaHome);
    console.log(`${join(keaHome, "config.json")}: ${config}`);
    console.log(`${join(keaHome, "auth.json")}: ${auth}`);
    return;
  }

  const projectDirectory = await resolveProjectDirectory(args.directory);
  // First-run fallback: `kea` without a prior `kea init` must not fail on
  // missing user files. Reuse init semantics (never overwrite) and report
  // only what was actually created.
  const created = await initializeUserConfiguration(keaHome);
  if (created.config === "created") {
    console.log(`${join(keaHome, "config.json")}: created`);
  }
  if (created.auth === "created") {
    console.log(`${join(keaHome, "auth.json")}: created`);
  }
  const config = await Config.load({
    keaHome,
    projectDirectory,
    ...(args.config === undefined ? {} : { configOverride: args.config }),
    verbose: args.verbose,
  });
  writeDiagnostic = (message: string): void => {
    console.error(config.redact(message));
  };
  const reportError = (error: unknown): void => {
    writeDiagnostic(error instanceof Error ? error.message : String(error));
  };

  if (config.verbose) {
    writeDiagnostic(`project directory: ${projectDirectory}`);
    for (const model of config.models) {
      writeDiagnostic(`model: ${model.provider}/${model.model}`);
    }
    for (const provider of config.runtimeProviders()) {
      writeDiagnostic(
        `credentials: ${provider.id} ${provider.apiKey === "" ? "missing" : "configured"}`,
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
    interactions: ui.interactions,
    maxTurns: config.maxTurns,
    toolTimeoutSeconds: config.toolTimeoutSeconds,
    onListenerError: (error) => {
      reportError(error);
    },
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
    writeDiagnostic(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
