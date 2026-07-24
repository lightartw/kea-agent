import { createInterface, type Interface } from "node:readline/promises";

import type { AgentEvent } from "../agent/types.js";
import type { AgentHarness } from "../harness/agent-harness.js";
import { renderAgentEvent } from "./render.js";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** The readline presentation adapter; core modules never import this class. */
export class CliFrontend {
  private readonly readline: Interface;

  constructor() {
    this.readline = createInterface({ input: process.stdin, output: process.stdout });
    this.readline.on("SIGINT", () => {
      this.readline.close();
    });
  }

  /** Keep accepting user turns while AgentHarness owns conversation state. */
  async run(harness: AgentHarness): Promise<void> {
    console.log("Agent Loop");
    console.log("Press Enter to send. ESC to abort streaming. 'q' to quit.\n");
    while (true) {
      let query: string;
      try {
        query = await this.readline.question(`${CYAN}>> ${RESET}`);
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

      // Enable ESC detection during streaming. In raw mode, ^C also becomes
      // a regular byte so we forward it to SIGINT ourselves.
      let onData: ((buf: Buffer) => void) | undefined;
      if (process.stdin.isTTY) {
        onData = (buf: Buffer): void => {
          if (buf[0] === 0x1b) {
            // ESC — abort the current prompt
            harness.abort();
          } else if (buf[0] === 0x03) {
            // ^C — forward as SIGINT signal
            process.kill(process.pid, "SIGINT");
          }
        };
        process.stdin.setRawMode(true);
        process.stdin.on("data", onData);
      }

      try {
        for await (const event of harness.prompt(query)) {
          renderAgentEvent(
            event,
            (text) => process.stdout.write(text),
            (text) => console.log(text),
          );
        }
      } finally {
        if (onData !== undefined) {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode(false);
        }
      }
      console.log();
    }
  }

  /** Safe to call after normal exit, Ctrl+C, or startup failure. */
  close(): void {
    this.readline.close();
  }
}
