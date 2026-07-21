import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { config as loadDotenv } from "dotenv";

import { runAgentTurn, type AgentEvent } from "./agent-turn.js";
import { createLLMClient } from "./llm-client/factory.js";
import type { Message } from "./llm-client/models.js";
import { createToolRegistry } from "./tools/factory.js";

const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

export function renderAgentEvent(
  event: AgentEvent,
  write: (text: string) => void,
  log: (text: string) => void,
): void {
  if (event.type === "text_delta") {
    write(event.text);
  } else if (event.type === "tool_start") {
    log(
      `\n\u001b[33m[tool] $ ${event.call.name}: ${JSON.stringify(event.call.arguments)}\u001b[0m`,
    );
  } else if (event.type === "tool_end") {
    const label = event.result.isError ? "\u001b[31m[tool error]" : "\u001b[90m[tool result]";
    log(`${label} ${event.call.name}\u001b[0m\n${event.result.content.slice(0, 200)}`);
  }
}

export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const client = await createLLMClient();
  const registry = createToolRegistry(process.cwd());
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.on("SIGINT", () => {
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
      for await (const event of runAgentTurn(history, client, registry)) {
        renderAgentEvent(
          event,
          (text) => process.stdout.write(text),
          (text) => console.log(text),
        );
      }
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
