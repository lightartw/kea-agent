import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { resolve } from "node:path";

import { Type, type Static } from "typebox";

import { Tool } from "../types.js";

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

function decodeOutput(output: Buffer): string {
  if (process.platform !== "win32") return output.toString("utf8");

  const gbk = new TextDecoder("gbk").decode(output);
  if (!isUtf8(output)) return gbk;

  const utf8 = output.toString("utf8");
  // Some GBK byte pairs are accidentally valid UTF-8 (for example, 目录 becomes
  // Ŀ¼). Latin-extended or private-use characters are typical of that mojibake;
  // actual Node tools such as tsx emit normal UTF-8 instead.
  return /[\u0100-\u024f\ue000-\uf8ff]/u.test(utf8) ? gbk : utf8;
}

export class BashTool extends Tool<typeof bashParameters> {
  readonly cwd: string;

  constructor(cwd = process.cwd()) {
    super("bash", "Run a shell command.", bashParameters);
    this.cwd = resolve(cwd);
  }

  async execute(
    arguments_: Static<typeof bashParameters>,
    signal: AbortSignal,
  ): Promise<string> {
    const { command } = arguments_;
    if (DANGEROUS_COMMAND_FRAGMENTS.some((fragment) => command.includes(fragment))) {
      throw new Error("Dangerous command blocked");
    }
    if (signal.aborted) throw signal.reason;

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(command, {
        cwd: this.cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.once("error", (error) => {
        rejectPromise(error);
      });

      child.once("close", (code) => {
        const outputBuffer = Buffer.concat([...stdout, ...stderr]);
        const output = decodeOutput(outputBuffer).trim();
        if (code !== 0) {
          const detail = output ? `\n${output}` : "";
          rejectPromise(new Error(`Command exited with code ${String(code)}${detail}`));
          return;
        }
        resolvePromise(output || "(no output)");
      });
    });
  }
}
