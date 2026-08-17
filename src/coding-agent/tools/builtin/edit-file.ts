import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

import { AgentTool } from "../../../core/agent/tools/types.js";
import { resolveToolPath } from "../resolve-path.js";

/** The absolute target and how many exact replacements were made. */
export interface EditFileDetails {
  readonly path: string;
  readonly replacements: 1;
}

const parameters = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path of the file to edit." }),
    old_text: Type.String({
      minLength: 1,
      description: "Exact text to replace. Must occur exactly once.",
    }),
    new_text: Type.String({ description: "Replacement text." }),
  },
  { additionalProperties: false },
);

class EditFileTool extends AgentTool<typeof parameters, EditFileDetails> {
  private readonly cwd: string;

  constructor(cwd: string) {
    super("edit_file", "Replace exact text in a file once.", parameters);
    this.cwd = cwd;
  }

  async execute(
    arguments_: { path: string; old_text: string; new_text: string },
    _signal: AbortSignal,
  ): Promise<{
    content: string;
    details?: EditFileDetails;
    isError: boolean;
  }> {
    const target = resolveToolPath(this.cwd, arguments_.path);
    try {
      const content = await readFile(target, "utf8");
      const first = content.indexOf(arguments_.old_text);
      if (first === -1) {
        return {
          content: `Error: text not found in ${arguments_.path}`,
          isError: true,
        };
      }
      // Search from first + 1 so overlapping matches count as ambiguous too.
      const second = content.indexOf(arguments_.old_text, first + 1);
      if (second !== -1) {
        const count = countOccurrences(content, arguments_.old_text);
        return {
          content: `Error: text appears ${count} times in ${arguments_.path}; expected exactly one`,
          isError: true,
        };
      }
      const replaced =
        content.slice(0, first) +
        arguments_.new_text +
        content.slice(first + arguments_.old_text.length);
      await writeFile(target, replaced, "utf8");
      return {
        content: `Edited ${arguments_.path} (1 replacement)`,
        details: { path: target, replacements: 1 },
        isError: false,
      };
    } catch (error) {
      return {
        content: `Error: Unable to edit ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }
}

/** Count non-overlapping occurrences for an informative ambiguity message. */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + 1;
  }
  return count;
}

/** Create the built-in edit tool, resolving paths relative to the given cwd. */
export function createEditFileTool(
  cwd: string,
): AgentTool<typeof parameters, EditFileDetails> {
  return new EditFileTool(resolve(cwd));
}
