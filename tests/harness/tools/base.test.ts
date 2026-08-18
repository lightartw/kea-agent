import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { AgentTool, type AgentToolResult } from "../../../src/core/harness/tools/types.js";

const parameters = Type.Object({ value: Type.String() });

class EchoTool extends AgentTool<typeof parameters> {
  constructor() {
    super("echo", "Echo text.", parameters);
  }

  async execute(arguments_: Static<typeof parameters>): Promise<AgentToolResult> {
    return { content: arguments_.value, isError: false };
  }
}

test("Tool exposes name, description, and parameters", () => {
  const tool = new EchoTool();
  assert.equal(tool.name, "echo");
  assert.equal(tool.description, "Echo text.");
  assert.equal(tool.parameters, parameters);
});
