import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { config as loadDotenv } from "dotenv";

import { agentLoop } from "./agent-loop.js";
import { createLLMClient } from "./llm-client/factory.js";
import type { LLMResponse, Message } from "./llm-client/models.js";
import { BashTool } from "./tools/builtin/bash.js";
import { ToolRegistry } from "./tools/registry.js";

const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

export function createToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new BashTool({ cwd }));
  return registry;
}

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const client = createLLMClient();
  const registry = createToolRegistry(process.cwd());
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let activeRun: AbortController | undefined;
  let interrupted = false;
  readline.on("SIGINT", () => {
    interrupted = true;
    activeRun?.abort(new Error("Interrupted"));
    readline.close();
  });

  console.log("s01: Agent Loop");
  console.log("输入问题，回车发送。输入 q 退出。\n");
  const history: Message[] = [
    {
      role: "system",
      content: `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`,
    },
  ];

  try {
    while (true) {
      let query: string;
      try {
        query = await readline.question(`${CYAN}s01 >> ${RESET}`);
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

      history.push({ role: "user", content: query });
      activeRun = new AbortController();
      let response: LLMResponse;
      try {
        response = await agentLoop(history, client, registry, activeRun.signal);
      } catch (error) {
        if (interrupted && activeRun.signal.aborted) break;
        throw error;
      } finally {
        activeRun = undefined;
      }
      if (response.content) console.log(response.content);
      console.log();
    }
  } finally {
    readline.close();
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
