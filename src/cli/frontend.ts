import { createInterface, type Interface } from "node:readline/promises";

import type { AgentHarness } from "../agent/harness/agent-harness.js";
import type {
  CodingHookUI,
  HookConfirmation,
  HookNotification,
} from "../coding-agent/types.js";
import { renderAgentEvent } from "./render.js";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

interface CliFrontendOptions {
  readonly readline?: Interface;
  readonly input?: NodeJS.ReadStream;
  readonly write?: (text: string) => void;
  readonly log?: (text: string) => void;
}

/** The readline presentation adapter; core modules never import this class. */
export class CliFrontend implements CodingHookUI {
  readonly available = true;
  private readonly readline: Interface;
  private readonly inputStream: NodeJS.ReadStream;
  private readonly writeFn: (text: string) => void;
  private readonly logFn: (text: string) => void;

  private runOnData: ((buf: Buffer) => void) | undefined;

  constructor(options: CliFrontendOptions = {}) {
    this.readline = options.readline ??
      createInterface({ input: process.stdin, output: process.stdout });
    this.inputStream = options.input ?? process.stdin;
    this.writeFn = options.write ?? ((text: string) => process.stdout.write(text));
    this.logFn = options.log ?? ((text: string) => console.log(text));

    this.readline.on("SIGINT", () => {
      this.readline.close();
    });
  }

  // ── CodingHookUI ──

  async confirm(
    confirmation: HookConfirmation,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Temporarily detach the run ESC listener
    this.detachRunListener();

    const confirmationController = new AbortController();
    let confirmationDone = false;

    const onEsc = (buf: Buffer): void => {
      if (buf[0] === 0x1b && !confirmationDone) {
        confirmationDone = true;
        confirmationController.abort();
      }
    };

    try {
      if (this.inputStream.isTTY) {
        this.inputStream.setRawMode(true);
        this.inputStream.on("data", onEsc);
      }

      const combinedSignal = signal !== undefined
        ? AbortSignal.any([signal, confirmationController.signal])
        : confirmationController.signal;

      const answer = await this.readline.question(
        `\n⚠ ${confirmation.title}\n   ${confirmation.message}\n   Allow? [y/N] `,
        { signal: combinedSignal },
      );
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || confirmationDone)
      ) {
        return false;
      }
      throw error;
    } finally {
      if (this.inputStream.isTTY) {
        this.inputStream.removeListener("data", onEsc);
        this.inputStream.setRawMode(false);
      }
      // Restore the run ESC listener
      this.restoreRunListener();
    }
  }

  notify(notification: HookNotification): void {
    this.logFn(notification.message);
  }

  // ── Private: run listener management ──

  private detachRunListener(): void {
    if (this.runOnData !== undefined && this.inputStream.isTTY) {
      this.inputStream.removeListener("data", this.runOnData);
    }
  }

  private restoreRunListener(): void {
    if (this.runOnData !== undefined && this.inputStream.isTTY) {
      this.inputStream.on("data", this.runOnData);
    }
  }

  // ── Run loop ──

  /** Keep accepting user turns while AgentHarness owns conversation state. */
  async run(harness: AgentHarness): Promise<void> {
    const unsubscribe = harness.subscribe((event) => {
      renderAgentEvent(
        event,
        (text) => this.writeFn(text),
        (text) => this.logFn(text),
      );
    });

    this.logFn("Agent Loop");
    this.logFn("Press Enter to send. ESC to abort streaming. 'q' to quit.\n");

    try {
      while (true) {
        let query: string;
        try {
          query = await this.readline.question(`${CYAN}>> ${RESET}`);
        } catch {
          break;
        }
        if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

        if (this.inputStream.isTTY) {
          this.runOnData = (buf: Buffer): void => {
            if (buf[0] === 0x1b) {
              harness.abort();
            } else if (buf[0] === 0x03) {
              process.kill(process.pid, "SIGINT");
            }
          };
          this.inputStream.setRawMode(true);
          this.inputStream.on("data", this.runOnData);
        }

        try {
          await harness.prompt(query);
        } finally {
          if (this.runOnData !== undefined) {
            this.inputStream.removeListener("data", this.runOnData);
            this.inputStream.setRawMode(false);
          }
        }
        this.logFn("");
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
