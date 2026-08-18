import { readFile, readdir, stat } from "node:fs/promises";
import { Type } from "typebox";

import { AgentTool } from "../../../core/harness/tools/types.js";
import { resolveToolPath } from "../resolve-path.js";
import { MAX_OUTPUT_LINES, truncateHead } from "../output.js";

/** What was read: the absolute path, its kind, and the applied pagination. */
export interface ReadFileDetails {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly offset: number;
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
}

const parameters = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path to a file or directory." }),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "One-based line to start from." })),
    limit: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: MAX_OUTPUT_LINES,
      description: "Maximum lines or entries to return.",
    })),
  },
  { additionalProperties: false },
);

/** Split on CRLF or LF and drop the empty element left by a trailing newline. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Order entries independently of locale so listings are deterministic. */
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class ReadFileTool extends AgentTool<typeof parameters, ReadFileDetails> {
  private readonly cwd: string;

  constructor(cwd: string) {
    super("read_file", "Read a text file or list a directory.", parameters);
    this.cwd = cwd;
  }

  async execute(
    arguments_: {
      path: string;
      offset?: number;
      limit?: number;
    },
    _signal: AbortSignal,
  ): Promise<{
    content: string;
    details?: ReadFileDetails;
    isError: boolean;
  }> {
    const resolved = resolveToolPath(this.cwd, arguments_.path);
    const offset = arguments_.offset ?? 1;
    const limit = arguments_.limit ?? MAX_OUTPUT_LINES;
    try {
      const info = await stat(resolved);
      const kind = info.isDirectory() ? "directory" : "file";
      const selected = kind === "directory"
        ? await this.readDirectory(resolved, offset, limit)
        : await this.readFile(resolved, offset, limit);
      const paginatedAway = selected.count < selected.total;
      const content = selected.content === ""
        ? kind === "directory" ? "(no entries)" : "(no content)"
        : selected.content;
      return {
        content,
        details: {
          path: resolved,
          kind,
          offset,
          total: selected.total,
          returned: selected.count,
          truncated: selected.truncated || paginatedAway,
        },
        isError: false,
      };
    } catch (error) {
      return {
        content: `Error: Unable to read ${resolved}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  private async readFile(
    resolved: string,
    offset: number,
    limit: number,
  ): Promise<{ content: string; total: number; count: number; truncated: boolean }> {
    const lines = splitLines(await readFile(resolved, "utf8"));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const selected = truncateHead(slice.join("\n"));
    return {
      content: selected.content,
      total: lines.length,
      count: selected.content === "" ? 0 : splitLines(selected.content).length,
      truncated: selected.truncated,
    };
  }

  private async readDirectory(
    resolved: string,
    offset: number,
    limit: number,
  ): Promise<{ content: string; total: number; count: number; truncated: boolean }> {
    const entries = await readdir(resolved, { withFileTypes: true });
    const names = entries
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort(compareNames);
    const slice = names.slice(offset - 1, offset - 1 + limit);
    const selected = truncateHead(slice.join("\n"));
    return {
      content: selected.content,
      total: names.length,
      count: selected.content === "" ? 0 : splitLines(selected.content).length,
      truncated: selected.truncated,
    };
  }
}

/** Create the built-in read tool, resolving paths relative to the given cwd. */
export function createReadFileTool(cwd: string): AgentTool<typeof parameters, ReadFileDetails> {
  return new ReadFileTool(cwd);
}
