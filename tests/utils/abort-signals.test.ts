import assert from "node:assert/strict";
import test from "node:test";

import { combineAbortSignals } from "../../src/utils/abort-signals.js";

test("combineAbortSignals preserves the first abort reason", () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);

  first.abort("caller cancelled");
  second.abort("timeout");

  assert.equal(combined.signal?.aborted, true);
  assert.equal(combined.signal?.reason, "caller cancelled");
  combined.cleanup();
});

test("cleanup detaches listeners from combined signals", () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);

  combined.cleanup();
  first.abort("late abort");

  assert.equal(combined.signal?.aborted, false);
});
