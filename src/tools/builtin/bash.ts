import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { Type, type Static } from "typebox";

import { Tool } from "../base.js";
import { ToolExecutionError } from "../errors.js";

const DANGEROUS_COMMAND_FRAGMENTS = [
  "rm -rf /",
  "sudo",
  "shutdown",
  "reboot",
  "> /dev/",
] as const;

const bashParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute." }),
  },
  { additionalProperties: false },
);

export interface BashToolOptions {
  readonly cwd?: string;
  readonly timeout?: number | null;
}

export class BashTool extends Tool<typeof bashParameters> {
  readonly cwd: string;

  constructor(options: BashToolOptions = {}) {
    super(
      "bash",
      "Run a shell command.",
      bashParameters,
      options.timeout ?? null,
    );
    this.cwd = resolve(options.cwd ?? process.cwd());
  }

  async execute(
    arguments_: Static<typeof bashParameters>,
    signal: AbortSignal,
  ): Promise<string> {
    const { command } = arguments_;
    if (DANGEROUS_COMMAND_FRAGMENTS.some((fragment) => command.includes(fragment))) {
      throw new ToolExecutionError("Dangerous command blocked");
    }
    if (signal.aborted) throw signal.reason;

    return new Promise<string>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(command, {
          cwd: this.cwd,
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          rejectPromise(signal.reason);
        } else {
          rejectPromise(
            new ToolExecutionError(
              `Failed to start command: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            ),
          );
        }
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.once("error", (error) => {
        if (signal.aborted || error.name === "AbortError") {
          rejectPromise(error);
        } else {
          rejectPromise(
            new ToolExecutionError(`Failed to start command: ${error.message}`, {
              cause: error,
            }),
          );
        }
      });

      child.once("close", (code) => {
        const outputBuffer = Buffer.concat([...stdout, ...stderr]);
        const output = (
          process.platform === "win32"
            ? new TextDecoder("gbk").decode(outputBuffer)
            : outputBuffer.toString("utf8")
        ).trim();
        if (code !== 0) {
          const detail = output ? `\n${output}` : "";
          rejectPromise(
            new ToolExecutionError(`Command exited with code ${String(code)}${detail}`),
          );
          return;
        }
        resolvePromise(output || "(no output)");
      });
    });
  }
}
