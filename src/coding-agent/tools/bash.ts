import { resolve } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";

import { LocalBashOperations } from "./bash-ops.js";
import { hardDeniedBashReason } from "./bash-policy.js";
import type { CodingToolDefinition } from "./definition.js";

/** Swappable execution backend for shell commands. */
export interface BashOperations {
  exec(command: string, cwd: string, signal: AbortSignal): Promise<string>;
}

const parameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute." }),
  },
  { additionalProperties: false },
);

export function createBashToolDefinition(
  ops: BashOperations = new LocalBashOperations(),
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
        const content = await ops.exec(command, resolve(context.cwd), signal);
        return { content, isError: false };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}
