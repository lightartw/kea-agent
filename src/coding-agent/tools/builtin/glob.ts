import { glob } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import { AgentTool } from "../../../core/harness/tools/types.js";
import { MAX_OUTPUT_BYTES } from "../output.js";

/** Glob match lists are capped at 1,000 entries, tighter than line output. */
const MAX_OUTPUT_ENTRIES = 1_000;

/** Metrics about the bounded match list attached to every glob result. */
export interface GlobDetails {
  readonly total: number;
  readonly returned: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

const parameters = Type.Object(
  { pattern: Type.String({ minLength: 1, description: "Glob pattern to match." }) },
  { additionalProperties: false },
);

/** Order matches independently of locale and of filesystem iteration order. */
function compareMatches(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class GlobTool extends AgentTool<typeof parameters, GlobDetails> {
  private readonly cwd: string;

  constructor(cwd: string) {
    super("glob", "Find paths matching a glob pattern.", parameters);
    this.cwd = cwd;
  }

  async execute(
    arguments_: { pattern: string },
    _signal: AbortSignal,
  ): Promise<{
    content: string;
    details?: GlobDetails;
    isError: boolean;
  }> {
    try {
      const unique = new Set<string>();
      for await (const match of glob(arguments_.pattern, { cwd: this.cwd })) {
        // Normalize to a slash-separated path relative to the tool cwd.
        unique.add(relative(this.cwd, resolve(this.cwd, match)).split(sep).join("/"));
      }
      const sorted = [...unique].sort(compareMatches);
      const total = sorted.length;
      const lines: string[] = [];
      let budget = 0;
      for (const match of sorted) {
        if (lines.length >= MAX_OUTPUT_ENTRIES) break;
        const newlineCost = lines.length > 0 ? 1 : 0;
        const entryBytes = Buffer.byteLength(match, "utf8");
        if (budget + entryBytes + newlineCost > MAX_OUTPUT_BYTES) break;
        lines.push(match);
        budget += entryBytes + newlineCost;
      }
      const selected = lines.join("\n");
      const truncated = lines.length < total;
      const bytes = Buffer.byteLength(selected, "utf8");
      const content = selected === ""
        ? "(no matches)"
        : truncated
          ? `${selected}\n[Showing ${lines.length} of ${total} matches]`
          : selected;
      return {
        content,
        details: {
          total,
          returned: lines.length,
          bytes,
          truncated,
        },
        isError: false,
      };
    } catch (error) {
      // Node's glob silently skips unreadable paths, so this branch is
      // defensive; a failure here would be an internal or argument error.
      return {
        content: `Error: Unable to glob ${arguments_.pattern}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }
}

/** Create the built-in glob tool, matching relative to the given cwd. */
export function createGlobTool(cwd: string): AgentTool<typeof parameters, GlobDetails> {
  return new GlobTool(resolve(cwd));
}
