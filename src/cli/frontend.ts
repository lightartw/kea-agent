import { createInterface, type Interface } from "node:readline/promises";

import type { AgentEvent } from "../agent/agent-loop.js";
import type { AgentHarness } from "../agent/harness/agent-harness.js";
import type { PermissionRequest } from "../coding/hooks/permission.js";
import { renderAgentEvent } from "./render.js";

const CYAN = "[36m";
const RESET = "[0m";

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
    console.log(`\n[33m[permission] ${request.reason}[0m`);
    console.log(`  ${request.call.name}: ${JSON.stringify(request.call.arguments)}`);
    try {
      const answer = await this.readline.question("  Allow? [y/N] ");
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } catch {
      return false;
    }
  }

  /** Keep accepting user turns while AgentHarness owns conversation state. */
  async run(harness: AgentHarness): Promise<void> {
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

      for await (const event of harness.prompt(query)) {
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
