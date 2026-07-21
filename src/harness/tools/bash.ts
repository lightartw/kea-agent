import { resolve } from "node:path";

import type { Static } from "typebox";
import { Type } from "typebox";

import type { BashOperations, ToolDefinition } from "./types.js";
import { LocalBashOperations } from "./bash-ops.js";

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

export function createBashToolDefinition(
  cwd: string = process.cwd(),
  ops: BashOperations = new LocalBashOperations(),
): ToolDefinition<typeof parameters> {
  const resolvedCwd = resolve(cwd);

  return {
    name: "bash",
    description: "Run a shell command.",
    parameters,
    async execute(arguments_: Static<typeof parameters>, signal: AbortSignal) {
      const { command } = arguments_;
      if (blockedBashFragment(command) !== undefined) {
        throw new Error("Dangerous command blocked");
      }
      return ops.exec(command, resolvedCwd, signal);
    },
  };
}
