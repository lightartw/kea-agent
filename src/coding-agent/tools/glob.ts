import { glob } from "node:fs/promises";
import { sep } from "node:path";

import type { Static } from "typebox";
import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";
import { safePath } from "../../utils/workspace.js";

const parameters = Type.Object(
  {
    pattern: Type.String({
      description: "Glob pattern relative to the workspace.",
    }),
  },
  { additionalProperties: false },
);

export class GlobTool extends AgentTool<typeof parameters> {
  constructor(private readonly workspace: string) {
    super("glob", "Find files matching a glob pattern.", parameters);
  }

  async execute(arguments_: Static<typeof parameters>, _signal: AbortSignal): Promise<AgentToolResult> {
    const matches: string[] = [];
    for await (const match of glob(arguments_.pattern, {
      cwd: this.workspace,
    })) {
      safePath(this.workspace, match);
      matches.push(match.split(sep).join("/"));
    }
    return { content: matches.length ? matches.join("\n") : "(no matches)", isError: false };
  }
}
