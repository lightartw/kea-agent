import { glob } from "node:fs/promises";
import { sep } from "node:path";

import type { Static } from "typebox";
import { Type } from "typebox";

import { safePath } from "../../utils/workspace.js";
import type { CodingToolDefinition } from "./definition.js";

const parameters = Type.Object(
  {
    pattern: Type.String({
      description: "Glob pattern relative to the workspace.",
    }),
  },
  { additionalProperties: false },
);

export function createGlobToolDefinition(): CodingToolDefinition<typeof parameters> {
  return {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters,
    async execute(arguments_: Static<typeof parameters>, _signal, context) {
      const matches: string[] = [];
      for await (const match of glob(arguments_.pattern, {
        cwd: context.cwd,
      })) {
        safePath(context.cwd, match);
        matches.push(match.split(sep).join("/"));
      }
      return { content: matches.length ? matches.join("\n") : "(no matches)", isError: false };
    },
  };
}
