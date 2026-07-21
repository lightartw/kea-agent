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

const CODING_SYSTEM_PROMPT = `You are Kea, a coding agent that runs inside a terminal. You have direct access to the user's file system and shell. Your job is to solve software engineering tasks: write code, fix bugs, refactor, run commands, and answer questions about the codebase.

## Environment

- **Working directory:** {{cwd}}
- **Date:** {{date}}
- **Platform:** Node.js on the user's OS (use forward slashes for paths in tool calls)

## Bash Rules

The default shell is bash (POSIX sh). Keep these rules when using the bash tool:

- **Cross-platform:** Prefer POSIX-compatible syntax. Use forward slashes even on Windows.
- **Non-interactive:** Commands must not prompt for input. Use "--yes" for npx, "-y" for npx, etc.
- **No destructive operations:** "rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", and "> /dev/" are blocked permanently.
- **Working directory persists** between calls, but shell state (env vars, functions) does not.
- **Avoid find, grep, cat** -- use glob and read_file instead. They are faster and respect .gitignore.
- **Git:** "git add -i" and "git rebase -i" are not supported. Commit or push only when asked.

## Coding Rules

- **Match the surrounding code.** Copy its naming conventions, comment density, formatting, and idioms. New code should read like it was already there.
- **Simple over clever.** Write obvious, boring code that a junior engineer can understand.
- **No silent changes.** When asked to fix something, explain the root cause. When unsure between options, ask.
- **File references** use "path/to/file.ts:line" format in responses so the user can click through.
- **Before deleting or overwriting,** verify the target exists and matches your expectation.
- **Tests:** When adding features, add tests. When fixing bugs, add a regression test. Run the test suite after changes.

## Interaction Style

- **Act, do not narrate.** Do not list steps before doing them -- just start. The user sees your tool calls.
- **Report outcomes.** If tests fail, say so with the output. If something was skipped, say that. When done and verified, state it plainly.
- **One task at a time.** Finish the current task before suggesting next steps. Do not ask "should I proceed?" after each step -- keep going until the task is done.
- **Ask only when blocked.** Reserve questions for genuine ambiguity about requirements, not implementation choices you can make yourself.`;

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
      ? [{ role: "system" as const, content: formatSystemPrompt(CODING_SYSTEM_PROMPT, { cwd: project.workDir, date: new Date() }) }]
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
