import { createInterface, type Interface } from "node:readline/promises";

import type {
  CodingAgentInteractions,
  ConfirmationRequest,
  Notification,
} from "../coding-agent/index.js";

interface CliInteractionsOptions {
  readonly readline?: Interface;
  readonly input?: NodeJS.ReadStream;
  readonly log?: (text: string) => void;
}

/** Concrete input adapter that implements CodingAgentInteractions. */
export class CliInteractions implements CodingAgentInteractions {
  readonly available = true;
  private readonly readline: Interface;
  private readonly inputStream: NodeJS.ReadStream;
  private readonly logFn: (text: string) => void;
  private runAbort: ((buf: Buffer) => void) | undefined;

  constructor(options: CliInteractionsOptions = {}) {
    this.readline = options.readline ??
      createInterface({ input: process.stdin, output: process.stdout });
    this.inputStream = options.input ?? process.stdin;
    this.logFn = options.log ?? ((text: string) => console.log(text));

    this.readline.on("SIGINT", () => {
      this.readline.close();
    });
  }

  /** Install the run ESC listener and return an idempotent unbind function. */
  bindRunAbort(abort: () => void): () => void {
    let active = true;
    const onData = (buf: Buffer): void => {
      if (buf[0] === 0x1b) {
        abort();
      } else if (buf[0] === 0x03) {
        process.kill(process.pid, "SIGINT");
      }
    };
    this.runAbort = onData;
    if (this.inputStream.isTTY) {
      this.inputStream.setRawMode(true);
      this.inputStream.on("data", onData);
    }
    return () => {
      if (!active) return;
      active = false;
      if (this.runAbort === onData) this.runAbort = undefined;
      if (this.inputStream.isTTY) {
        this.inputStream.removeListener("data", onData);
        this.inputStream.setRawMode(false);
      }
    };
  }

  async confirm(
    request: ConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Temporarily detach the run ESC listener
    const runAbort = this.runAbort;
    if (runAbort !== undefined && this.inputStream.isTTY) {
      this.inputStream.removeListener("data", runAbort);
    }

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
        `\n⚠ ${request.title}\n   ${request.message}\n   Allow? [y/N] `,
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
      if (runAbort !== undefined && this.inputStream.isTTY) {
        this.inputStream.on("data", runAbort);
      }
    }
  }

  notify(notification: Notification): void {
    this.logFn(notification.message);
  }

  /** Safe to call after normal exit, Ctrl+C, or startup failure. */
  close(): void {
    this.readline.close();
  }
}
