import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

export function blockedBashFragment(command: string): string | undefined {
  return DANGEROUS_COMMAND_FRAGMENTS.find((fragment) => command.includes(fragment));
}

const bashParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute." }),
  },
  { additionalProperties: false },
);

type Shell = {
  command: string;
  arguments: string[];
  commandOnStdin: boolean;
};

function getShell(): Shell {
  if (process.platform !== "win32") {
    return { command: "bash", arguments: ["-c"], commandOnStdin: false };
  }

  // cmd.exe follows the active Windows code page. Like Pi, prefer Git Bash so
  // both the command language and output are consistently UTF-8. The legacy
  // WSL launcher is more reliable when the command is passed through stdin.
  const gitBash = resolve(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) {
    return { command: gitBash, arguments: ["-c"], commandOnStdin: false };
  }
  return { command: "bash.exe", arguments: ["-s"], commandOnStdin: true };
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
    if (blockedBashFragment(command) !== undefined) {
      throw new Error("Dangerous command blocked");
    }
    if (signal.aborted) throw signal.reason;

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const shell = getShell();
      const child = spawn(
        shell.command,
        shell.commandOnStdin ? shell.arguments : [...shell.arguments, command],
        {
          cwd: this.cwd,
          windowsHide: true,
          stdio: [shell.commandOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
          signal,
        },
      );
      if (shell.commandOnStdin) child.stdin?.end(command);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.once("error", (error) => {
        rejectPromise(error);
      });

      child.once("close", (code) => {
        const outputBuffer = Buffer.concat([...stdout, ...stderr]);
        // Decode after combining all chunks, so UTF-8 characters cannot be
        // split at a chunk boundary.
        const output = outputBuffer.toString("utf8").trim();
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
