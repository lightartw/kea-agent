import assert from "node:assert/strict";
import test from "node:test";

import { createHookRegistry } from "../../../src/coding/hooks/factory.js";
import { HookRegistry } from "../../../src/agent/hooks/registry.js";
import {
  type Hook,
  type HookEvent,
  type HookResult,
  type PreToolUseEvent,
} from "../../../src/agent/hooks/types.js";

class TestHook implements Hook<PreToolUseEvent> {
  readonly eventType = "pre_tool_use";

  constructor(
    readonly name: string,
    private readonly run: () => HookResult | Promise<HookResult>,
  ) {}

  async execute(_event: PreToolUseEvent): Promise<HookResult> {
    return this.run();
  }
}

const event: PreToolUseEvent = {
  type: "pre_tool_use",
  call: { id: "call-1", name: "test", arguments: {} },
};

test("HookRegistry runs hooks in order and stops at the first block", async () => {
  const observed: string[] = [];
  const registry = new HookRegistry();
  registry.register(new TestHook("first", () => { observed.push("first"); return undefined; }));
  registry.register(new TestHook("block", () => {
    observed.push("block");
    return { block: true, reason: "blocked" };
  }));
  registry.register(new TestHook("last", () => { observed.push("last"); return undefined; }));

  assert.deepEqual(await registry.trigger(event), { block: true, reason: "blocked" });
  assert.deepEqual(observed, ["first", "block"]);
});

test("HookRegistry rejects duplicate names", () => {
  const registry = new HookRegistry();
  registry.register(new TestHook("test", () => ({ block: true, reason: "blocked" })));
  assert.throws(() => registry.register(new TestHook("test", () => undefined)), /already registered/);
});

test("createHookRegistry registers every supplied hook", async () => {
  const observed: string[] = [];
  const registry = createHookRegistry([
    new TestHook("first", () => { observed.push("first"); return undefined; }),
    new TestHook("second", () => { observed.push("second"); return undefined; }),
  ]);

  await registry.trigger(event);
  assert.deepEqual(observed, ["first", "second"]);
});

test("HookRegistry reports hook failures", async () => {
  const registry = new HookRegistry();
  registry.register(new TestHook("broken", () => { throw new Error("boom"); }));

  await assert.rejects(registry.trigger(event), /hook 'broken' failed/);
});

test("HookRegistry dispatches without knowing concrete hook event types", async () => {
  interface TestEvent extends HookEvent {
    readonly type: "test_event";
    readonly value: string;
  }

  let observed = "";
  const hook: Hook<TestEvent> = {
    name: "test-event",
    eventType: "test_event",
    async execute(testEvent) {
      observed = testEvent.value;
      return undefined;
    },
  };
  const registry = new HookRegistry();
  registry.register(hook);

  await registry.trigger({ type: "test_event", value: "handled" });
  assert.equal(observed, "handled");
});
