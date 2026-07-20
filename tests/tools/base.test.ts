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

  async execute(arguments_: Static<typeof echoParameters>): Promise<string> {
    return arguments_.value;
  }
}

test("Tool exports its OpenAI function schema", () => {
  assert.deepEqual(new EchoTool().toSchema(), {
    type: "function",
    function: {
      name: "echo",
      description: "Echo a value.",
      parameters: echoParameters,
    },
  });
});
