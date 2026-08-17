import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";

import { AgentTool } from "../../../core/agent/tools/types.js";
import { resolveToolPath } from "../resolve-path.js";

/** The absolute target, the UTF-8 byte count, and whether the file was new. */
export interface WriteFileDetails {
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
}

const parameters = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Path of the file to write." }),
    content: Type.String({ description: "Complete file content." }),
  },
  { additionalProperties: false },
);

/** Only a missing target counts as "created"; any other stat failure is real. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "ENOENT";
}

class WriteFileTool extends AgentTool<typeof parameters, WriteFileDetails> {
  private readonly cwd: string;

  constructor(cwd: string) {
    super("write_file", "Write complete content to a file.", parameters);
    this.cwd = cwd;
  }

  async execute(
    arguments_: { path: string; content: string },
    _signal: AbortSignal,
  ): Promise<{
    content: string;
    details?: WriteFileDetails;
    isError: boolean;
  }> {
    const target = resolveToolPath(this.cwd, arguments_.path);
    try {
      let created: boolean;
      try {
        await stat(target);
        created = false;
      } catch (error) {
        if (!isMissing(error)) throw error;
        created = true;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, arguments_.content, "utf8");
      const bytes = Buffer.byteLength(arguments_.content, "utf8");
      return {
        content: `${created ? "Created" : "Overwrote"} ${arguments_.path} (${bytes} bytes)`,
        details: { path: target, bytes, created },
        isError: false,
      };
    } catch (error) {
      return {
        content: `Error: Unable to write ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }
}

/** Create the built-in write tool, resolving paths relative to the given cwd. */
export function createWriteFileTool(
  cwd: string,
): AgentTool<typeof parameters, WriteFileDetails> {
  return new WriteFileTool(resolve(cwd));
}
