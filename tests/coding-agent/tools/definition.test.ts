import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Static } from "typebox";

import {
  toAgentTool,
  type ToolDefinition,
} from "../../../src/coding-agent/tools/definition.js";

const parameters = Type.Object({ value: Type.Number() });

test("toAgentTool strips presentation and projects execution with context", async () => {
  const definition: ToolDefinition<typeof parameters, { value: number }> = {
    name: "sample",
    description: "Sample tool",
    parameters,
    async execute(arguments_: Static<typeof parameters>, _signal, context) {
      return {
        content: `${context.cwd}:${arguments_.value}`,
        details: { value: arguments_.value },
        isError: false,
      };
    },
    presentation: {
      renderCall: () => "call",
      renderResult: () => "result",
    },
  };

  const tool = toAgentTool(definition, { cwd: "C:/work", directories: ["C:/work"] });
  assert.equal(Object.hasOwn(tool, "presentation"), false);
  assert.deepEqual(
    await tool.execute({ value: 2 }, new AbortController().signal),
    { content: "C:/work:2", details: { value: 2 }, isError: false },
  );
});

test("toAgentTool exposes the tool metadata", () => {
  const definition: ToolDefinition<typeof parameters> = {
    name: "sample",
    description: "Sample tool",
    parameters,
    async execute() {
      return { content: "ok", isError: false };
    },
  };
  const tool = toAgentTool(definition, { cwd: "C:/work", directories: ["C:/work"] });
  assert.equal(tool.name, "sample");
  assert.equal(tool.description, "Sample tool");
  assert.equal(tool.parameters, parameters);
  assert.equal(tool.validate({ value: 1 }), undefined);
  assert.ok(tool.validate({ value: "not-a-number" }));
});
