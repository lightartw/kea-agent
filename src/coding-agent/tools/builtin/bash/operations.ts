import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { BashOperations } from "./definition.js";

type Shell = {
  command: string;
  arguments: string[];
  commandOnStdin: boolean;
};

function getShell(): Shell {
  if (process.platform !== "win32") {
    return { command: "bash", arguments: ["-c"], commandOnStdin: false };
  }

  const gitBash = resolve(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "bin",
    "bash.exe",
  );
  if (existsSync(gitBash)) {
    return { command: gitBash, arguments: ["-c"], commandOnStdin: false };
  }
  return { command: "bash.exe", arguments: ["-s"], commandOnStdin: true };
}

/**
 * Default execution backend that spawns a local child process. Extracted as a
 * standalone implementation of BashOperations so callers can swap in SSH,
 * Docker, or other backends later.
 */
export class LocalBashOperations implements BashOperations {
  async exec(command: string, cwd: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw signal.reason;

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const shell = getShell();
      const child = spawn(
        shell.command,
        shell.commandOnStdin
          ? shell.arguments
          : [...shell.arguments, command],
        {
          cwd,
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
        const output = outputBuffer.toString("utf8").trim();
        if (code !== 0) {
          const detail = output ? `\n${output}` : "";
          rejectPromise(
            new Error(`Command exited with code ${String(code)}${detail}`),
          );
          return;
        }
        resolvePromise(output || "(no output)");
      });
    });
  }
}
