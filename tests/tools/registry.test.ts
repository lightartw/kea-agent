import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { Tool } from "../../src/tools/base.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const parameters = Type.Object({ value: Type.String() });

class EchoTool extends Tool<typeof parameters> {
  constructor(name = "echo") {
    super(name, "Echo text.", parameters);
  }

  async execute(arguments_: Static<typeof parameters>): Promise<string> {
    return arguments_.value;
  }
}

test("Registry registers, unregisters, and exports schemas", () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));
  registry.unregister("first");
  assert.deepEqual(registry.schemas().map((schema) => schema.function.name), ["second"]);
});

test("Registry executes valid calls and reports invalid calls", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  assert.deepEqual(await registry.execute({ id: "1", name: "echo", arguments: { value: "ok" } }), {
    content: "ok",
    isError: false,
  });
  assert.equal(
    (await registry.execute({ id: "2", name: "echo", arguments: {} })).isError,
    true,
  );
});

test("Registry applies its global timeout", async () => {
  class HangingTool extends EchoTool {
    override async execute(): Promise<string> {
      return new Promise(() => undefined);
    }
  }
  const registry = new ToolRegistry(0.001);
  registry.register(new HangingTool());
  assert.equal(
    (await registry.execute({ id: "1", name: "echo", arguments: { value: "x" } })).isError,
    true,
  );
});
