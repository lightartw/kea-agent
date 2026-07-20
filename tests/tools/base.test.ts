import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { Tool } from "../../src/tools/base.js";

const echoParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

class EchoTool extends Tool<typeof echoParameters> {
  constructor() {
    super("echo", "Echo a value.", echoParameters);
  }

  async execute(
    arguments_: Static<typeof echoParameters>,
  ): Promise<string> {
    return arguments_.value;
  }
}

test("Tool exports an OpenAI function schema", () => {
  assert.deepEqual(new EchoTool().toSchema(), {
    type: "function",
    function: {
      name: "echo",
      description: "Echo a value.",
      parameters: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
    },
  });
});

test("Tool owns immutable parameters and returns fresh schema clones", () => {
  const source = Type.Object(
    { value: Type.String() },
    { additionalProperties: false },
  );
  class OwnedTool extends Tool<typeof source> {
    constructor() {
      super("owned", "Own the schema.", source);
    }
    async execute(): Promise<string> {
      return "ok";
    }
  }
  const tool = new OwnedTool();
  (source.properties as any).added = { type: "number" };
  const first = tool.toSchema();
  (first.function.parameters as any).added = true;
  const second = tool.toSchema();

  assert.equal((tool.parameters.properties as any).added, undefined);
  assert.equal((second.function.parameters as any).added, undefined);
  assert.equal(Object.isFrozen(tool.parameters), true);
  assert.equal(Object.isFrozen(tool.parameters.properties), true);
});
