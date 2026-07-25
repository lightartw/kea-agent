import assert from "node:assert/strict";
import test from "node:test";

import { HookRegistry } from "../../../src/agent/hooks/registry.js";

test("earlyExit stops at first block result", async () => {
  const calls: string[] = [];
  const registry = new HookRegistry();

  registry.register("tool_call", async () => {
    calls.push("first");
    return { block: true, reason: "denied" };
  });
  registry.register("tool_call", async () => {
    calls.push("second"); // should NOT run
  });

  const result = await registry.trigger("tool_call", { toolName: "bash" });
  assert.deepEqual(result, { block: true, reason: "denied" });
  assert.deepEqual(calls, ["first"]);
});

test("earlyExit returns undefined when all handlers pass", async () => {
  const registry = new HookRegistry();
  const calls: string[] = [];
  registry.register("tool_call", async () => { calls.push("a"); return undefined; });
  registry.register("tool_call", async () => { calls.push("b"); return undefined; });

  const result = await registry.trigger("tool_call", {});
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["a", "b"]);
});

test("transform chains handlers", async () => {
  const registry = new HookRegistry();
  registry.register("context", async (event) => {
    const e = event as { messages: string[] };
    return { messages: [...e.messages, "first"] };
  });
  registry.register("context", async (event) => {
    const e = event as { messages: string[] };
    return { messages: [...e.messages, "second"] };
  });

  const result = await registry.trigger("context", { messages: ["original"] });
  assert.deepEqual(result, { messages: ["original", "first", "second"] });
});

test("transform propagates when handler returns null/undefined", async () => {
  const registry = new HookRegistry();
  registry.register("context", async () => undefined);
  registry.register("context", async (event) => {
    const e = event as { messages: string[] };
    return { messages: [...e.messages, "added"] };
  });

  const result = await registry.trigger("context", { messages: ["x"] });
  assert.deepEqual(result, { messages: ["x", "added"] });
});

test("patch accumulates results", async () => {
  const registry = new HookRegistry();
  registry.register("tool_result", async () => ({ content: "patched-content" }));
  registry.register("tool_result", async () => ({ isError: true }));

  const result = await registry.trigger("tool_result", {});
  assert.deepEqual(result, { content: "patched-content", isError: true });
});

test("observe runs all handlers but returns undefined", async () => {
  const calls: string[] = [];
  const registry = new HookRegistry();
  registry.register("turn_end", async () => { calls.push("a"); });
  registry.register("turn_end", async () => { calls.push("b"); });

  const result = await registry.trigger("turn_end", { message: "done" });
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["a", "b"]);
});

test("handlers run in registration order", async () => {
  const order: number[] = [];
  const registry = new HookRegistry();

  registry.register("turn_end", async () => { order.push(1); });
  registry.register("turn_end", async () => { order.push(2); });
  registry.register("turn_end", async () => { order.push(3); });

  await registry.trigger("turn_end", {});
  assert.deepEqual(order, [1, 2, 3]);
});

test("register returns unsubscribe function", async () => {
  const calls: string[] = [];
  const registry = new HookRegistry();

  const unsub = registry.register("turn_end", async () => { calls.push("a"); });
  unsub();
  await registry.trigger("turn_end", {});
  assert.deepEqual(calls, []);
});

test("handler exception propagates to caller", async () => {
  const registry = new HookRegistry();
  const failure = new Error("handler failed");
  registry.register("tool_call", async () => { throw failure; });

  await assert.rejects(
    registry.trigger("tool_call", {}),
    (error) => error === failure,
  );
});

test("handler exception does not execute subsequent handlers", async () => {
  const calls: string[] = [];
  const registry = new HookRegistry();
  registry.register("tool_call", async () => { calls.push("first"); throw new Error("fail"); });
  registry.register("tool_call", async () => { calls.push("second"); });

  await assert.rejects(registry.trigger("tool_call", {}));
  assert.deepEqual(calls, ["first"]);
});

test("custom reducer overrides default", async () => {
  const registry = new HookRegistry({ tool_call: "observe" });
  const calls: string[] = [];
  registry.register("tool_call", async () => { calls.push("a"); return { block: true }; });
  registry.register("tool_call", async () => { calls.push("b"); });

  const result = await registry.trigger("tool_call", {});
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["a", "b"]);
});

test("unknown event type defaults to observe", async () => {
  const registry = new HookRegistry();
  const calls: string[] = [];
  registry.register("custom_event", async () => { calls.push("run"); return { data: 1 }; });

  const result = await registry.trigger("custom_event", {});
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["run"]);
});

test("trigger with no handlers returns undefined", async () => {
  const registry = new HookRegistry();
  const result = await registry.trigger("tool_call", {});
  assert.equal(result, undefined);
});
