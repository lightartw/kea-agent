import assert from "node:assert/strict";
import test from "node:test";

import { HookRegistry } from "../../src/hooks/registry.js";
import {
  Hook,
  type HookContext,
  type HookResult,
  type PreToolUseEvent,
} from "../../src/hooks/types.js";

class TestHook extends Hook<PreToolUseEvent> {
  constructor(
    name: string,
    private readonly run: () => HookResult | Promise<HookResult>,
  ) {
    super(name, "pre_tool_use");
  }

  async execute(
    _event: PreToolUseEvent,
    _context: HookContext,
  ): Promise<HookResult> {
    return this.run();
  }
}

const event: PreToolUseEvent = {
  type: "pre_tool_use",
  call: { id: "call-1", name: "test", arguments: {} },
};

test("HookRegistry runs hooks in order and stops at the first block", async () => {
  const observed: string[] = [];
  const registry = new HookRegistry({ requestPermission: async () => false });
  registry.register(new TestHook("first", () => { observed.push("first"); return undefined; }));
  registry.register(new TestHook("block", () => {
    observed.push("block");
    return { block: true, reason: "blocked" };
  }));
  registry.register(new TestHook("last", () => { observed.push("last"); return undefined; }));

  assert.deepEqual(await registry.trigger(event), { block: true, reason: "blocked" });
  assert.deepEqual(observed, ["first", "block"]);
});

test("HookRegistry rejects duplicate names and supports unregister", async () => {
  const registry = new HookRegistry({ requestPermission: async () => false });
  registry.register(new TestHook("test", () => ({ block: true, reason: "blocked" })));
  assert.throws(() => registry.register(new TestHook("test", () => undefined)), /already registered/);

  registry.unregister("test");
  assert.equal(await registry.trigger(event), undefined);
});

test("HookRegistry reports hook failures", async () => {
  const registry = new HookRegistry({ requestPermission: async () => false });
  registry.register(new TestHook("broken", () => { throw new Error("boom"); }));

  await assert.rejects(registry.trigger(event), /hook 'broken' failed/);
});
