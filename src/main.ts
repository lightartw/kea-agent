import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadDotenv } from "dotenv";

import { AgentSession } from "./agent-session.js";
import { CliFrontend } from "./cli.js";
import { PermissionHook } from "./hooks/builtin/permission.js";
import { HookRegistry } from "./hooks/registry.js";
import { createLLMClient } from "./llm-client/factory.js";
import { createToolRegistry } from "./tools/factory.js";

/**
 * Node process composition root. Environment loading and concrete adapters stay
 * here so AgentSession, the agent loop, and hooks remain presentation-neutral.
 */
export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    // Assemble one runtime explicitly: provider, cross-cutting hooks, tools,
    // session state, then the current CLI presentation adapter.
    const client = await createLLMClient();
    const hooks = new HookRegistry();
    // Permission is an ordinary hook. The composition root supplies the current
    // presentation adapter, while the registry remains unaware of its needs.
    hooks.register(
      new PermissionHook((request) => cli.requestPermission(request)),
    );
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
