import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { AgentHarness } from "./agent/harness/agent-harness.js";
import { SessionRepo } from "./agent/harness/session/session-repo.js";
import type { Project } from "./agent/harness/types.js";
import { CliFrontend } from "./cli/frontend.js";
import { createHookRegistry } from "./coding/hooks/factory.js";
import type { PermissionHook } from "./coding/hooks/permission.js";
import { createToolRegistry } from "./coding/tools/factory.js";
import { createLLMClient } from "./llm-client/factory.js";
import { formatSystemPrompt } from "./agent/harness/system-prompt.js";

const CODING_SYSTEM_PROMPT = `You are a coding agent. Use bash, read_file, write_file, edit_file, and glob to solve tasks. Act, don't explain.`;

function resolveProject(cwd: string): Project {
  // Encode path as ID: /d/programming/kea_agent → -d-programming-kea_agent
  const id = cwd.replace(/^([A-Za-z]):/, "-$1").replace(/[/\\]/g, "-");
  const storageRoot = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
  return {
    id,
    name: null, // anonymous project; named projects added later
    workDir: cwd,
    storageDir: resolve(storageRoot, "projects", id),
  };
}

/**
 * Node process composition root. Environment loading and concrete adapters stay
 * here so AgentSession, the agent loop, and hooks remain presentation-neutral.
 */
export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    // 1. AI layer
    const client = await createLLMClient();

    // 2. Project (anonymous by default, from cwd)
    const project = resolveProject(process.cwd());

    // 3. Coding-specific hooks and tools. Factories auto-register built-in
    //    hooks and tools so main.ts never constructs individual instances.
    const hooks = createHookRegistry();
    // Wire the presentation adapter post-creation. The factory owns built-in
    // hook instances; callers only inject infrastructure callbacks.
    hooks.get<PermissionHook>("permission")!.requestPermission =
      (request) => cli.requestPermission(request);
    const toolRegistry = createToolRegistry(project.workDir, hooks);

    // 4. Harness — wires project, persistence, and agent loop together
    const repo = new SessionRepo(project);
    const sessionStore = await repo.create();
    const harness = new AgentHarness(
      project,
      sessionStore,
      client,
      toolRegistry,
      formatSystemPrompt(CODING_SYSTEM_PROMPT),
    );

    // 5. CLI presentation
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
