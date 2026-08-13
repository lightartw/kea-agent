import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";

import { hardDeniedBashReason } from "./bash-policy.js";
import type { CodingToolDefinition } from "../definition.js";

type ExecuteBash = (
  command: string,
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

interface Shell {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly commandOnStdin: boolean;
}

const parameters = Type.Object(
  { command: Type.String({ description: "Shell command to execute." }) },
  { additionalProperties: false },
);

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

async function executeLocalBash(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw signal.reason;
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const shell = getShell();
    const child = spawn(
      shell.command,
      shell.commandOnStdin ? shell.arguments : [...shell.arguments, command],
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
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
      if (code !== 0) {
        rejectPromise(new Error(
          `Command exited with code ${String(code)}${output ? `\n${output}` : ""}`,
        ));
        return;
      }
      resolvePromise(output || "(no output)");
    });
  });
}

export function createBashToolDefinition(
  executeBash: ExecuteBash = executeLocalBash,
): CodingToolDefinition<typeof parameters> {
  return {
    name: "bash",
    description: "Run a shell command.",
    parameters,
    async execute(
      arguments_: Static<typeof parameters>,
      signal: AbortSignal,
      context,
    ) {
      const { command } = arguments_;
      const reason = hardDeniedBashReason(command);
      if (reason !== undefined) {
        return {
          content: `Error: Permission denied: ${reason}`,
          isError: true,
        };
      }
      try {
        return {
          content: await executeBash(command, resolve(context.cwd), signal),
          isError: false,
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}
