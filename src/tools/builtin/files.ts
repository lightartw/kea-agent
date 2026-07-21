import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Type, type Static } from "typebox";

import { Tool } from "../types.js";
import { safePath } from "./workspace.js";

const readParameters = Type.Object(
  {
    path: Type.String({ description: "Path relative to the workspace." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines to read." })),
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

export class ReadFileTool extends Tool<typeof readParameters> {
  constructor(private readonly workspace: string) {
    super("read_file", "Read file contents.", readParameters);
  }

  async execute(
    arguments_: Static<typeof readParameters>,
    _signal: AbortSignal,
  ): Promise<string> {
    const lines = (await readFile(safePath(this.workspace, arguments_.path), "utf8")).split(/\r?\n/);
    if (arguments_.limit !== undefined && arguments_.limit < lines.length) {
      return [...lines.slice(0, arguments_.limit), `... (${lines.length - arguments_.limit} more lines)`].join("\n");
    }
    return lines.join("\n");
  }
}

export class WriteFileTool extends Tool<typeof writeParameters> {
  constructor(private readonly workspace: string) {
    super("write_file", "Write content to a file.", writeParameters);
  }

  async execute(
    arguments_: Static<typeof writeParameters>,
    _signal: AbortSignal,
  ): Promise<string> {
    const path = safePath(this.workspace, arguments_.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, arguments_.content, "utf8");
    return `Wrote ${Buffer.byteLength(arguments_.content, "utf8")} bytes to ${arguments_.path}`;
  }
}

export class EditFileTool extends Tool<typeof editParameters> {
  constructor(private readonly workspace: string) {
    super("edit_file", "Replace exact text in a file once.", editParameters);
  }

  async execute(
    arguments_: Static<typeof editParameters>,
    _signal: AbortSignal,
  ): Promise<string> {
    const path = safePath(this.workspace, arguments_.path);
    const content = await readFile(path, "utf8");
    const index = content.indexOf(arguments_.old_text);
    if (index === -1) throw new Error(`text not found in ${arguments_.path}`);
    await writeFile(
      path,
      content.slice(0, index) + arguments_.new_text + content.slice(index + arguments_.old_text.length),
      "utf8",
    );
    return `Edited ${arguments_.path}`;
  }
}
