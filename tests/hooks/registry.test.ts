import assert from "node:assert/strict";
import test from "node:test";

import { HookRegistry } from "../../src/hooks/registry.js";
import {
  type HookResult,
  type PreToolUseHook,
} from "../../src/hooks/types.js";
import type { ToolCall } from "../../src/tools/types.js";

class TestHook implements PreToolUseHook {
  constructor(
    readonly name: string,
    private readonly run: () => HookResult | Promise<HookResult>,
  ) {}

  async execute(_call: ToolCall): Promise<HookResult> {
    return this.run();
  }
}

const call: ToolCall = { id: "call-1", name: "test", arguments: {} };

test("HookRegistry runs hooks in order and stops at the first block", async () => {
  const observed: string[] = [];
  const registry = new HookRegistry();
  registry.register(new TestHook("first", () => { observed.push("first"); return undefined; }));
  registry.register(new TestHook("block", () => {
    observed.push("block");
    return { block: true, reason: "blocked" };
  }));
  registry.register(new TestHook("last", () => { observed.push("last"); return undefined; }));

  assert.deepEqual(await registry.triggerPreToolUse(call), { block: true, reason: "blocked" });
  assert.deepEqual(observed, ["first", "block"]);
});

test("HookRegistry rejects duplicate names", () => {
  const registry = new HookRegistry();
  registry.register(new TestHook("test", () => ({ block: true, reason: "blocked" })));
  assert.throws(() => registry.register(new TestHook("test", () => undefined)), /already registered/);
});

test("HookRegistry reports hook failures", async () => {
  const registry = new HookRegistry();
  registry.register(new TestHook("broken", () => { throw new Error("boom"); }));

  await assert.rejects(registry.triggerPreToolUse(call), /hook 'broken' failed/);
});
