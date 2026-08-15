import assert from "node:assert/strict";
import test from "node:test";

import {
  TimeoutError,
  runWithTimeout,
  timeoutMilliseconds,
} from "../../src/core/util/timeout.js";

test("timeoutMilliseconds rounds up fractional milliseconds", () => {
  assert.equal(timeoutMilliseconds(1.2345), 1_235);
});

test("timeoutMilliseconds rejects values outside the Node timer range", () => {
  assert.throws(() => timeoutMilliseconds(0), RangeError);
  assert.throws(() => timeoutMilliseconds(2_147_483.648), RangeError);
});

test("runWithTimeout supplies a signal and returns the operation result", async () => {
  let received: AbortSignal | undefined;
  const result = await runWithTimeout(1, async (signal) => {
    received = signal;
    return "ok";
  });

  assert.equal(result, "ok");
  assert.ok(received instanceof AbortSignal);
  assert.equal(received.aborted, false);
});

test("runWithTimeout rejects when an operation does not settle", async () => {
  await assert.rejects(
    runWithTimeout(0.001, async () => new Promise(() => undefined)),
    TimeoutError,
  );
});

test("runWithTimeout rejects a hanging operation when the caller aborts", async () => {
  const controller = new AbortController();
  const operation = runWithTimeout(
    10,
    () => new Promise<never>(() => undefined),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(operation);
});
