import assert from "node:assert/strict";
import test from "node:test";

import { Events } from "../../src/events/events.js";

declare module "../../src/events/types.js" {
  interface EventMap {
    "test/fact": EventContract<"emit", { readonly value: number }>;
    "test/question": EventContract<"ask", { readonly prompt: string }, string>;
    "test/value": EventContract<"transform", number>;
  }
}

test("emit snapshots listeners, preserves order, and isolates failures", async () => {
  const failures: string[] = [];
  const calls: string[] = [];
  const events = new Events((error, dispatch) => {
    failures.push(`${dispatch.name}:${(error as Error).message}`);
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
  assert.deepEqual(failures, ["test/fact:broken", "test/fact:broken"]);
});

test("ask returns the first non-undefined answer and stops", async () => {
  const events = new Events();
  const called: string[] = [];
  events.on("test/question", () => {
    called.push("first");
    return undefined;
  });
  events.on("test/question", () => {
    called.push("second");
    return "second";
  });
  events.on("test/question", () => {
    called.push("third");
    return "third";
  });

  const answer = await events.ask("test/question", { prompt: "p" });
  assert.equal(answer, "second");
  assert.deepEqual(called, ["first", "second"]);
});

test("transform passes each value to the next middleware", async () => {
  const events = new Events();
  events.on("test/value", (value, next) => next(value + 1));
  events.on("test/value", (value, next) => next(value * 2));

  const result = await events.transform("test/value", 1);
  assert.equal(result, 4);
});

test("transform middleware may stop the chain without next", async () => {
  const events = new Events();
  const called: string[] = [];
  events.on("test/value", (value, next) => {
    called.push("first");
    return next(value + 1);
  });
  events.on("test/value", (value) => {
    called.push("stopping");
    return value * 10;
  });
  events.on("test/value", () => {
    called.push("third");
    throw new Error("should not run");
  });

  const result = await events.transform("test/value", 1);
  assert.equal(result, 20);
  assert.deepEqual(called, ["first", "stopping"]);
});

test("ask propagates listener errors", async () => {
  const events = new Events();
  events.on("test/question", () => {
    throw new Error("ask failed");
  });
  await assert.rejects(
    events.ask("test/question", { prompt: "p" }),
    /ask failed/,
  );
});

test("transform propagates listener errors", async () => {
  const events = new Events();
  events.on("test/value", () => {
    throw new Error("transform failed");
  });
  await assert.rejects(events.transform("test/value", 1), /transform failed/);
});

test("ask and transform check an already-aborted signal", async () => {
  const events = new Events();
  events.on("test/question", () => "answer");
  events.on("test/value", (value, next) => next(value + 1));

  const aborted = AbortSignal.abort();
  await assert.rejects(
    events.ask("test/question", { prompt: "p" }, aborted),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  await assert.rejects(
    events.transform("test/value", 1, aborted),
    (error: unknown) => (error as Error).name === "AbortError",
  );
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

test("transform preserves outer post-processing", async () => {
  const events = new Events();
  events.on("test/value", async (value, next) => {
    const downstream = await next(value + 1);
    return downstream + 3;
  });
  events.on("test/value", (value) => value * 2);

  assert.equal(await events.transform("test/value", 1), 7);
});

test("transform rejects a second next call without rerunning downstream", async () => {
  const events = new Events();
  let downstreamCalls = 0;
  events.on("test/value", async (value, next) => {
    await next(value);
    return next(value);
  });
  events.on("test/value", (value) => {
    downstreamCalls += 1;
    return value;
  });

  await assert.rejects(events.transform("test/value", 1), /next.*once/i);
  assert.equal(downstreamCalls, 1);
});
