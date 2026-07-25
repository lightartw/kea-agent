import { createInterface, type Interface } from "node:readline/promises";

import type { AgentHarness } from "../agent/harness/agent-harness.js";
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
    const unsubscribe = harness.subscribe((event) => {
      renderAgentEvent(
        event,
        (text) => process.stdout.write(text),
        (text) => console.log(text),
      );
    });

    console.log("Agent Loop");
    console.log("Press Enter to send. ESC to abort streaming. 'q' to quit.\n");

    try {
      while (true) {
        let query: string;
        try {
          query = await this.readline.question(`${CYAN}>> ${RESET}`);
        } catch {
          break;
        }
        if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

        let onData: ((buf: Buffer) => void) | undefined;
        if (process.stdin.isTTY) {
          onData = (buf: Buffer): void => {
            if (buf[0] === 0x1b) {
              harness.abort();
            } else if (buf[0] === 0x03) {
              process.kill(process.pid, "SIGINT");
            }
          };
          process.stdin.setRawMode(true);
          process.stdin.on("data", onData);
        }

        try {
          await harness.prompt(query);
        } finally {
          if (onData !== undefined) {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(false);
          }
        }
        console.log();
      }
    } finally {
      unsubscribe();
    }
  }

  /** Safe to call after normal exit, Ctrl+C, or startup failure. */
  close(): void {
    this.readline.close();
  }
}
