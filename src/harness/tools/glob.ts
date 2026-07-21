import { glob } from "node:fs/promises";
import { sep } from "node:path";

import type { Static } from "typebox";
import { Type } from "typebox";

import { safePath } from "../../utils/workspace.js";
import type { ToolDefinition } from "./types.js";

const parameters = Type.Object(
  {
    pattern: Type.String({
      description: "Glob pattern relative to the workspace.",
    }),
  },
  { additionalProperties: false },
);

export function createGlobDefinition(
  workspace: string,
): ToolDefinition<typeof parameters> {
  return {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters,
    async execute(arguments_: Static<typeof parameters>) {
      const matches: string[] = [];
      for await (const match of glob(arguments_.pattern, {
        cwd: workspace,
      })) {
        safePath(workspace, match);
        matches.push(match.split(sep).join("/"));
      }
      return matches.length ? matches.join("\n") : "(no matches)";
    },
  };
}
