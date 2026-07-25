import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Static } from "typebox";
import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../agent/tools/types.js";
import { safePath } from "../../utils/workspace.js";

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

export class ReadFileTool extends AgentTool<typeof readParameters> {
  constructor(private readonly workspace: string) {
    super("read_file", "Read file contents.", readParameters);
  }

  async execute(arguments_: Static<typeof readParameters>, _signal: AbortSignal): Promise<AgentToolResult> {
    const lines = (
      await readFile(safePath(this.workspace, arguments_.path), "utf8")
    ).split(/\r?\n/);
    const content = arguments_.limit !== undefined && arguments_.limit < lines.length
      ? [...lines.slice(0, arguments_.limit), `... (${lines.length - arguments_.limit} more lines)`].join("\n")
      : lines.join("\n");
    return { content, isError: false };
  }
}

export class WriteFileTool extends AgentTool<typeof writeParameters> {
  constructor(private readonly workspace: string) {
    super("write_file", "Write content to a file.", writeParameters);
  }

  async execute(arguments_: Static<typeof writeParameters>, _signal: AbortSignal): Promise<AgentToolResult> {
    const path = safePath(this.workspace, arguments_.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, arguments_.content, "utf8");
    return { content: `Wrote ${Buffer.byteLength(arguments_.content, "utf8")} bytes to ${arguments_.path}`, isError: false };
  }
}

export class EditFileTool extends AgentTool<typeof editParameters> {
  constructor(private readonly workspace: string) {
    super("edit_file", "Replace exact text in a file once.", editParameters);
  }

  async execute(arguments_: Static<typeof editParameters>, _signal: AbortSignal): Promise<AgentToolResult> {
    const path = safePath(this.workspace, arguments_.path);
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
  }
}
