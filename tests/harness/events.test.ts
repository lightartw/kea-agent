import assert from "node:assert/strict";
import test from "node:test";

import { HarnessEventBus } from "../../src/harness/events/event-bus.js";
import { liftAgentEvent } from "../../src/harness/events/types.js";

test("liftAgentEvent keeps the flat discriminant and adds run identity", () => {
  assert.deepEqual(
    liftAgentEvent(
      { type: "text_delta", text: "hello" },
      { lane: "main", runId: "run-1" },
    ),
    { type: "text_delta", text: "hello", lane: "main", runId: "run-1" },
  );
});

test("event bus snapshots listeners and isolates failures", async () => {
  const errors: unknown[] = [];
  const bus = new HarnessEventBus((error) => errors.push(error));
  const calls: string[] = [];
  bus.subscribe(() => { calls.push("first"); throw new Error("listener failed"); });
  bus.subscribe(() => { calls.push("second"); });

  await bus.publish({ type: "run_start", lane: "main", runId: "run-1" });

  assert.deepEqual(calls, ["first", "second"]);
  assert.equal((errors[0] as Error).message, "listener failed");
});

test("unsubscribe removes the listener", async () => {
  const bus = new HarnessEventBus();
  const calls: string[] = [];
  const unsubscribe = bus.subscribe(() => { calls.push("hit"); });
  unsubscribe();
  await bus.publish({ type: "run_start", lane: "main", runId: "run-1" });
  assert.deepEqual(calls, []);
});
