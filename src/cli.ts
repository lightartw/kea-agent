import { createInterface, type Interface } from "node:readline/promises";

import type { AgentEvent } from "./agent-turn.js";
import type { AgentSession } from "./agent-session.js";
import type { PermissionRequest } from "./hooks/types.js";

const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** Convert presentation-neutral agent events into the current line-based UI. */
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

/** The readline presentation adapter; core modules never import this class. */
export class CliFrontend {
  private readonly readline: Interface;

  constructor() {
    this.readline = createInterface({ input: process.stdin, output: process.stdout });
    this.readline.on("SIGINT", () => {
      this.readline.close();
    });
  }

  /** Show one approval request. EOF and Ctrl+C are denials, not approvals. */
  async requestPermission(request: PermissionRequest): Promise<boolean> {
    console.log(`\n\u001b[33m[permission] ${request.reason}\u001b[0m`);
    console.log(`  ${request.call.name}: ${JSON.stringify(request.call.arguments)}`);
    try {
      const answer = await this.readline.question("  Allow? [y/N] ");
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } catch {
      return false;
    }
  }

  /** Keep accepting user turns while AgentSession owns conversation state. */
  async run(session: AgentSession): Promise<void> {
    console.log("s01: Agent Loop");
    console.log("输入问题，回车发送。输入 q 退出。\n");
    while (true) {
      let query: string;
      try {
        query = await this.readline.question(`${CYAN}s01 >> ${RESET}`);
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

      for await (const event of session.submit(query)) {
        renderAgentEvent(
          event,
          (text) => process.stdout.write(text),
          (text) => console.log(text),
        );
      }
      console.log();
    }
  }

  /** Safe to call after normal exit, Ctrl+C, or startup failure. */
  close(): void {
    this.readline.close();
  }
}
