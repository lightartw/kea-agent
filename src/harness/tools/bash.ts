import { resolve } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";
import { LocalBashOperations } from "./bash-ops.js";

/** Swappable execution backend for shell commands. */
export interface BashOperations {
  exec(command: string, cwd: string, signal: AbortSignal): Promise<string>;
}

const DANGEROUS_COMMAND_FRAGMENTS = [
  "rm -rf /",
  "sudo",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "> /dev/",
] as const;

export function blockedBashFragment(command: string): string | undefined {
  return DANGEROUS_COMMAND_FRAGMENTS.find((fragment) =>
    command.includes(fragment),
  );
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
    if (blockedBashFragment(command) !== undefined) {
      return { content: "Error: Dangerous command blocked", isError: true };
    }
    try {
      const content = await this.ops.exec(command, this.resolvedCwd, signal);
      return { content, isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}
