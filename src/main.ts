import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { CliFrontend } from "./ui/cli-frontend.js";
import { createCodingAgent } from "./coding-agent/factory.js";
import { Session } from "./harness/session/session.js";
import { createStreamFn } from "./ai/factory.js";

function resolveProject(cwd: string) {
  const id = cwd.replace(/^([A-Za-z]):/, "-$1").replace(/[/\\]/g, "-");
  const storageRoot = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
  return { workDir: cwd, storageDir: resolve(storageRoot, "projects", id) };
}

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    const { stream, defaultModel } = createStreamFn();
    const project = resolveProject(process.cwd());
    const session = await Session.create(project.storageDir);
    const runtime = await createCodingAgent({
      project,
      streamFn: stream,
      model: defaultModel,
      session,
      interactions: cli.interactions,
    });
    await cli.run(runtime);
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
