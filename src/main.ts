import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { CliFrontend } from "./ui/cli-frontend.js";
import { openOrCreateProject } from "./coding-agent/factory.js";
import { createModelRuntime } from "./core/ai/factory.js";

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    const { runtime, modelConfig } = createModelRuntime();
    const keaHome = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
    const project = await openOrCreateProject({
      keaHome,
      runtime,
      modelConfig,
      interactions: cli.interactions,
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
