import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { Agent } from "./agent/agent.js";
import { AgentHarness } from "./harness/agent-harness.js";
import { SessionRepo } from "./harness/session/session-repo.js";
import type { Project } from "./harness/types.js";
import { CliFrontend } from "./cli/frontend.js";
import { createHookRegistry } from "./harness/hooks/factory.js";
import type { PermissionHook } from "./harness/hooks/permission.js";
import { createToolRegistry } from "./harness/tools/factory.js";
import { createLLMClient } from "./llm-client/factory.js";
import { formatSystemPrompt } from "./harness/system-prompt.js";

const CODING_SYSTEM_PROMPT = `You are a coding agent. Use bash, read_file, write_file, edit_file, and glob to solve tasks. Act, don't explain.`;

function resolveProject(cwd: string): Project {
  const id = cwd.replace(/^([A-Za-z]):/, "-$1").replace(/[/\\]/g, "-");
  const storageRoot = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
  return {
    id,
    name: null,
    workDir: cwd,
    storageDir: resolve(storageRoot, "projects", id),
  };
}

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    // 1. AI layer
    const client = await createLLMClient();

    // 2. Project and session persistence
    const project = resolveProject(process.cwd());
    const repo = new SessionRepo(project);
    const sessionStore = await repo.create();

    // 3. Hooks and tools
    const hooks = createHookRegistry(project.workDir);
    hooks.get<PermissionHook>("permission")!.requestPermission = (request) =>
      cli.requestPermission(request);
    const toolRegistry = createToolRegistry(project.workDir, hooks);

    // 4. Agent — created once, holds history across turns. Like Pi's Agent
    //    class, it is stateful but persistence-agnostic.
    const history = await sessionStore.load();
    const messages = history.length === 0
      ? [{ role: "system" as const, content: formatSystemPrompt(CODING_SYSTEM_PROMPT) }]
      : [...history];
    const agent = new Agent(client, toolRegistry, messages, hooks);

    // 5. Harness — persistence layer around Agent. Like Pi's AgentSession,
    //    it holds a single Agent instance.
    const harness = new AgentHarness(sessionStore, agent);

    // 6. CLI presentation
    await cli.run(harness);
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
