import assert from "node:assert/strict";
import test from "node:test";

import { Events } from "../../src/events/events.js";

declare module "../../src/events/types.js" {
  interface EventMap {
    "test/fact": (
      input: { readonly value: number },
    ) => void | Promise<void>;
    "test/intercept": (
      input: number,
      proceed: (input: number) => Promise<number>,
      signal?: AbortSignal,
    ) => number | Promise<number>;
  }
}

test("emit snapshots listeners, preserves order, and isolates failures", async () => {
  const failures: string[] = [];
  const calls: string[] = [];
  const events = new Events((error, name, input) => {
    failures.push(`${name}:${(error as Error).message}:${(input as { value: number }).value}`);
  });
  let unregisterSecond: () => void = () => undefined;
  events.on("test/fact", async () => {
    calls.push("first");
    unregisterSecond();
    throw new Error("broken");
  });
  unregisterSecond = events.on("test/fact", () => { calls.push("second"); });

  await events.emit("test/fact", { value: 1 });
  await events.emit("test/fact", { value: 2 });

  assert.deepEqual(calls, ["first", "second", "first"]);
  assert.deepEqual(failures, [
    "test/fact:broken:1",
    "test/fact:broken:2",
  ]);
});

test("the same listener can be registered and removed independently", async () => {
  const events = new Events();
  const calls: number[] = [];
  const listener = (input: { readonly value: number }) => {
    calls.push(input.value);
  };

  const unregisterFirst = events.on("test/fact", listener);
  events.on("test/fact", listener);
  unregisterFirst();
  unregisterFirst();

  await events.emit("test/fact", { value: 1 });
  assert.deepEqual(calls, [1]);
});

test("unregister is idempotent", async () => {
  const events = new Events();
  const calls: string[] = [];
  const unregister = events.on("test/fact", () => { calls.push("hit"); });
  unregister();
  unregister();
  await events.emit("test/fact", { value: 1 });
  assert.deepEqual(calls, []);
});

test("emit isolates listener error reporting failures", async () => {
  const calls: string[] = [];
  const events = new Events(() => {
    throw new Error("reporter failed");
  });
  events.on("test/fact", () => {
    calls.push("first");
    throw new Error("listener failed");
  });
  events.on("test/fact", () => { calls.push("second"); });

  await events.emit("test/fact", { value: 1 });
  assert.deepEqual(calls, ["first", "second"]);
});

test("emit continues after a throwing listener and still completes", async () => {
  const events = new Events();
  const calls: string[] = [];
  events.on("test/fact", () => {
    calls.push("first");
    throw new Error("boom");
  });
  events.on("test/fact", () => { calls.push("second"); });

  await events.emit("test/fact", { value: 1 });

  assert.deepEqual(calls, ["first", "second"]);
});

test("intercept passes changed input through listeners in registration order", async () => {
  const events = new Events();
  events.on("test/intercept", (value, proceed) => proceed(value + 1));
  events.on("test/intercept", (value, proceed) => proceed(value * 2));

  const result = await events.intercept(
    "test/intercept",
    1,
    async (value) => value + 3,
  );

  assert.equal(result, 7);
});

test("intercept listener may stop before the final handler", async () => {
  const events = new Events();
  let finalCalls = 0;
  events.on("test/intercept", (value) => value * 10);

  const result = await events.intercept("test/intercept", 2, async (value) => {
    finalCalls += 1;
    return value;
  });

  assert.equal(result, 20);
  assert.equal(finalCalls, 0);
});

test("intercept preserves outer post-processing", async () => {
  const events = new Events();
  events.on("test/intercept", async (value, proceed) => {
    const downstream = await proceed(value + 1);
    return downstream + 3;
  });
  events.on("test/intercept", (value) => value * 2);

  assert.equal(await events.intercept("test/intercept", 1, async (value) => value), 7);
});

test("intercept rejects a second proceed call without rerunning downstream", async () => {
  const events = new Events();
  let downstreamCalls = 0;
  events.on("test/intercept", async (value, proceed) => {
    await proceed(value);
    return proceed(value);
  });
  events.on("test/intercept", (value) => {
    downstreamCalls += 1;
    return value;
  });

  await assert.rejects(events.intercept("test/intercept", 1, async (value) => value), /proceed.*once/i);
  assert.equal(downstreamCalls, 1);
});

test("intercept propagates listener errors", async () => {
  const events = new Events();
  events.on("test/intercept", () => {
    throw new Error("intercept failed");
  });
  await assert.rejects(
    events.intercept("test/intercept", 1, async (value) => value),
    /intercept failed/,
  );
});

test("intercept checks an already-aborted signal before dispatch", async () => {
  const events = new Events();
  events.on("test/intercept", (value, proceed) => proceed(value + 1));

  const aborted = AbortSignal.abort();
  await assert.rejects(
    events.intercept("test/intercept", 1, async (value) => value, aborted),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("intercept checks an aborted signal after an awaited listener", async () => {
  const events = new Events();
  let resolveListener: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { resolveListener = resolve; });
  events.on("test/intercept", async (value, proceed) => {
    await gate;
    return proceed(value + 1);
  });
  const controller = new AbortController();

  const run = events.intercept("test/intercept", 1, async (value) => value, controller.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();
  resolveListener();

  await assert.rejects(
    run,
    (error: unknown) => (error as Error).name === "AbortError",
  );
});
