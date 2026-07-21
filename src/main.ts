import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadDotenv } from "dotenv";

import { AgentSession } from "./agent-session.js";
import { CliFrontend } from "./cli.js";
import { createHookRegistry } from "./hooks/factory.js";
import { createLLMClient } from "./llm-client/factory.js";
import { createToolRegistry } from "./tools/factory.js";

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    const client = await createLLMClient();
    const hooks = createHookRegistry((request) => cli.requestPermission(request));
    const registry = createToolRegistry(process.cwd(), hooks);
    const session = new AgentSession(client, registry, [
      {
        role: "system",
        content: `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`,
      },
    ]);
    await cli.run(session);
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
