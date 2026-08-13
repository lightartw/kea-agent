import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { CliFrontend } from "./ui/cli-frontend.js";
import { createProject } from "./coding-agent/factory.js";
import { createStreamFn } from "./ai/factory.js";

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    const { stream, defaultModel } = createStreamFn();
    const keaHome = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
    const project = await createProject({
      keaHome,
      streamFn: stream,
      model: defaultModel,
      interactions: cli.interactions,
    });
    const harness = await project.continueRecent();
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
