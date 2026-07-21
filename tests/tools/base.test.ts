import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { Tool } from "../../src/tools/types.js";

const parameters = Type.Object({ value: Type.String() });

class EchoTool extends Tool<typeof parameters> {
  constructor() {
    super("echo", "Echo text.", parameters);
  }

  async execute(arguments_: Static<typeof parameters>): Promise<string> {
    return arguments_.value;
  }
}

test("Tool exports its function schema", () => {
  assert.deepEqual(new EchoTool().toSchema(), {
    type: "function",
    function: { name: "echo", description: "Echo text.", parameters },
  });
});
