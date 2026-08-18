import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { AgentTool } from "../../../core/harness/tools/types.js";
import { truncateTail } from "../output.js";

/** How a command is executed. Injected for tests; defaults to the local shell. */
export type ExecuteBash = (
  command: string,
  cwd: string,
  signal: AbortSignal,
) => Promise<{ readonly output: string; readonly exitCode: number | null }>;

/** Metrics about the bounded output attached to every bash result. */
export interface BashToolDetails {
  readonly exitCode: number | null;
  readonly truncated: boolean;
  readonly totalLines: number;
  readonly shownLines: number;
  readonly totalBytes: number;
  readonly shownBytes: number;
}

const parameters = Type.Object(
  { command: Type.String({ minLength: 1, description: "Shell command to execute." }) },
  { additionalProperties: false },
);

interface Shell {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly commandOnStdin: boolean;
}

/** Resolve the preferred bash for this platform, Git Bash on Windows. */
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
 * Run a command in the local shell and return its raw output and exit code.
 * stdout and stderr chunks are collected into one stream in arrival order.
 */
async function executeLocalBash(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number | null }> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolvePromise, rejectPromise) => {
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

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      resolvePromise({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

class BashTool extends AgentTool<typeof parameters, BashToolDetails> {
  private readonly cwd: string;

  constructor(
    cwd: string,
    private readonly executeBash: ExecuteBash,
  ) {
    super("bash", "Run a shell command.", parameters);
    this.cwd = resolve(cwd);
  }

  async execute(
    arguments_: { command: string },
    signal: AbortSignal,
  ): Promise<{ content: string; details: BashToolDetails; isError: boolean }> {
    const executed = await this.executeBash(arguments_.command, this.cwd, signal);
    const selected = truncateTail(executed.output);
    const output = selected.content === "" ? "(no output)" : selected.content;
    const status = executed.exitCode === 0
      ? output
      : `${output}\n\nCommand exited with code ${String(executed.exitCode)}`;
    return {
      content: selected.truncated
        ? `${status}\n\n[Output truncated: showing ${selected.shownLines} of ${selected.totalLines} lines and ${selected.shownBytes} of ${selected.totalBytes} bytes]`
        : status,
      details: {
        exitCode: executed.exitCode,
        truncated: selected.truncated,
        totalLines: selected.totalLines,
        shownLines: selected.shownLines,
        totalBytes: selected.totalBytes,
        shownBytes: selected.shownBytes,
      },
      isError: executed.exitCode !== 0,
    };
  }
}

/** Create the built-in bash tool, running commands relative to the given cwd. */
export function createBashTool(
  cwd: string,
  executeBash: ExecuteBash = executeLocalBash,
): AgentTool<typeof parameters, BashToolDetails> {
  return new BashTool(cwd, executeBash);
}
