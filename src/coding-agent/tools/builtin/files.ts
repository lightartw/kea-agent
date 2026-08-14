import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";

import type { Static } from "typebox";
import { Type } from "typebox";

import { safePath } from "../../../utils/workspace.js";
import type { ToolDefinition } from "../definition.js";

const readParameters = Type.Object(
  {
    path: Type.String({ description: "Path relative to the workspace." }),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, description: "Maximum lines to read." }),
    ),
  },
  { additionalProperties: false },
);

const writeParameters = Type.Object(
  {
    path: Type.String({ description: "Path relative to the workspace." }),
    content: Type.String({ description: "Complete file content." }),
  },
  { additionalProperties: false },
);

const editParameters = Type.Object(
  {
    path: Type.String({ description: "Path relative to the workspace." }),
    old_text: Type.String({ description: "Exact text to replace once." }),
    new_text: Type.String({ description: "Replacement text." }),
  },
  { additionalProperties: false },
);

const globParameters = Type.Object(
  {
    pattern: Type.String({
      description: "Glob pattern relative to the workspace.",
    }),
  },
  { additionalProperties: false },
);

export function createReadFileToolDefinition(): ToolDefinition<typeof readParameters> {
  return {
    name: "read_file",
    description: "Read file contents.",
    parameters: readParameters,
    async execute(arguments_: Static<typeof readParameters>, _signal, context) {
      const lines = (
        await readFile(safePath(context.cwd, context.directories, arguments_.path), "utf8")
      ).split(/\r?\n/);
      const content = arguments_.limit !== undefined && arguments_.limit < lines.length
        ? [...lines.slice(0, arguments_.limit), `... (${lines.length - arguments_.limit} more lines)`].join("\n")
        : lines.join("\n");
      return { content, isError: false };
    },
  };
}

export function createWriteFileToolDefinition(): ToolDefinition<typeof writeParameters> {
  return {
    name: "write_file",
    description: "Write content to a file.",
    parameters: writeParameters,
    async execute(arguments_: Static<typeof writeParameters>, _signal, context) {
      const path = safePath(context.cwd, context.directories, arguments_.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, arguments_.content, "utf8");
      return { content: `Wrote ${Buffer.byteLength(arguments_.content, "utf8")} bytes to ${arguments_.path}`, isError: false };
    },
  };
}

export function createEditFileToolDefinition(): ToolDefinition<typeof editParameters> {
  return {
    name: "edit_file",
    description: "Replace exact text in a file once.",
    parameters: editParameters,
    async execute(arguments_: Static<typeof editParameters>, _signal, context) {
      const path = safePath(context.cwd, context.directories, arguments_.path);
      const content = await readFile(path, "utf8");
      const index = content.indexOf(arguments_.old_text);
      if (index === -1) return { content: `Error: text not found in ${arguments_.path}`, isError: true };
      await writeFile(
        path,
        content.slice(0, index) +
          arguments_.new_text +
          content.slice(index + arguments_.old_text.length),
        "utf8",
      );
      return { content: `Edited ${arguments_.path}`, isError: false };
    },
  };
}

export function createGlobToolDefinition(): ToolDefinition<typeof globParameters> {
  return {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: globParameters,
    async execute(arguments_: Static<typeof globParameters>, _signal, context) {
      const matches: string[] = [];
      for await (const match of glob(arguments_.pattern, { cwd: context.cwd })) {
        safePath(context.cwd, context.directories, match);
        matches.push(match.split(sep).join("/"));
      }
      return {
        content: matches.length ? matches.join("\n") : "(no matches)",
        isError: false,
      };
    },
  };
}
