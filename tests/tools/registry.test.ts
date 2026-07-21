import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { HookRegistry } from "../../src/hooks/registry.js";
import {
  Hook,
  type HookContext,
  type HookResult,
  type PreToolUseEvent,
} from "../../src/hooks/types.js";
import { Tool } from "../../src/tools/types.js";
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

test("Registry validates before hooks and never executes a blocked call", async () => {
  let hookCalls = 0;
  let executions = 0;
  class BlockingHook extends Hook<PreToolUseEvent> {
    constructor() {
      super("block", "pre_tool_use");
    }
    async execute(
      _event: PreToolUseEvent,
      _context: HookContext,
    ): Promise<HookResult> {
      hookCalls += 1;
      return { block: true, reason: "blocked by test" };
    }
  }
  class ObservedTool extends EchoTool {
    override async execute(arguments_: Static<typeof parameters>): Promise<string> {
      executions += 1;
      return arguments_.value;
    }
  }
  const hooks = new HookRegistry({ requestPermission: async () => false });
  hooks.register(new BlockingHook());
  const registry = new ToolRegistry(120, hooks);
  registry.register(new ObservedTool());

  assert.equal(
    (await registry.execute({ id: "invalid", name: "echo", arguments: {} })).isError,
    true,
  );
  assert.equal(hookCalls, 0);

  const blocked = await registry.execute({ id: "valid", name: "echo", arguments: { value: "x" } });
  assert.deepEqual(blocked, { content: "Error: blocked by test", isError: true });
  assert.equal(hookCalls, 1);
  assert.equal(executions, 0);
});

test("Registry fails closed when a pre-tool hook throws", async () => {
  let executions = 0;
  class BrokenHook extends Hook<PreToolUseEvent> {
    constructor() {
      super("broken", "pre_tool_use");
    }
    async execute(): Promise<HookResult> {
      throw new Error("boom");
    }
  }
  class ObservedTool extends EchoTool {
    override async execute(arguments_: Static<typeof parameters>): Promise<string> {
      executions += 1;
      return arguments_.value;
    }
  }
  const hooks = new HookRegistry({ requestPermission: async () => false });
  hooks.register(new BrokenHook());
  const registry = new ToolRegistry(120, hooks);
  registry.register(new ObservedTool());

  const result = await registry.execute({ id: "1", name: "echo", arguments: { value: "x" } });
  assert.equal(result.isError, true);
  assert.match(result.content, /hook 'broken' failed/);
  assert.equal(executions, 0);
});
