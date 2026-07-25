import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { AgentTool, type AgentToolResult } from "../../../src/agent/tools/types.js";
import { AgentToolRegistry } from "../../../src/agent/tools/registry.js";

const parameters = Type.Object({ value: Type.String() });

class EchoTool extends AgentTool<typeof parameters> {
  constructor(name = "echo") {
    super(name, "Echo text.", parameters);
  }

  async execute(arguments_: Static<typeof parameters>): Promise<AgentToolResult> {
    return { content: arguments_.value, isError: false };
  }
}

test("Registry registers, unregisters, and exports schemas", () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));
  registry.unregister("first");
  assert.deepEqual(registry.schemas().map((schema) => schema.name), ["second"]);
});

test("Registry executes valid calls and reports invalid calls", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());
  assert.deepEqual(await registry.execute({ type: "toolCall", id: "1", name: "echo", arguments: { value: "ok" } }), {
    content: "ok",
    isError: false,
  });
  assert.equal(
    (await registry.execute({ type: "toolCall", id: "2", name: "echo", arguments: {} })).isError,
    true,
  );
});

test("Registry applies its global timeout", async () => {
  class HangingTool extends EchoTool {
    override async execute(): Promise<AgentToolResult> {
      return new Promise(() => undefined);
    }
  }
  const registry = new AgentToolRegistry(0.001);
  registry.register(new HangingTool());
  assert.equal(
    (await registry.execute({ type: "toolCall", id: "1", name: "echo", arguments: { value: "x" } })).isError,
    true,
  );
});
