import { resolve } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";
import { LocalBashOperations } from "./bash-ops.js";

/** Swappable execution backend for shell commands. */
export interface BashOperations {
  exec(command: string, cwd: string, signal: AbortSignal): Promise<string>;
}

const FORBIDDEN_BASH_FRAGMENTS = [
  "rm ",
  "rm -rf /",
  "sudo",
  "chmod 777",
  "shutdown",
  "reboot",
  "mkfs",
  "dd ",
  "> /etc/",
  "> /dev/",
] as const;

function blockedBashReason(command: string): string | undefined {
  const fragment = FORBIDDEN_BASH_FRAGMENTS.find((candidate) =>
    command.includes(candidate),
  );
  if (fragment === undefined) return undefined;
  return fragment === "rm "
    ? "file deletion is not allowed"
    : `command contains forbidden fragment '${fragment}'`;
}

const parameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute." }),
  },
  { additionalProperties: false },
);

export class BashTool extends AgentTool<typeof parameters> {
  private readonly resolvedCwd: string;

  constructor(
    cwd: string = process.cwd(),
    private readonly ops: BashOperations = new LocalBashOperations(),
  ) {
    super("bash", "Run a shell command.", parameters);
    this.resolvedCwd = resolve(cwd);
  }

  async execute(
    arguments_: Static<typeof parameters>,
    signal: AbortSignal,
  ): Promise<AgentToolResult> {
    const { command } = arguments_;
    const reason = blockedBashReason(command);
    if (reason !== undefined) {
      return {
        content: `Error: Permission denied: ${reason}`,
        isError: true,
      };
    }
    try {
      const content = await this.ops.exec(command, this.resolvedCwd, signal);
      return { content, isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}
