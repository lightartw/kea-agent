import assert from "node:assert/strict";
import test from "node:test";

import { resolveOptions } from "../../src/llm-client/factory.js";

test("call options override client defaults", () => {
  assert.deepEqual(
    resolveOptions(
      { maxTokens: 4_096, timeout: 60, temperature: 0.2 },
      { maxTokens: 7, timeout: 3 },
    ),
    { maxTokens: 7, timeout: 3, temperature: 0.2 },
  );
});

test("missing options use the common defaults", () => {
  assert.deepEqual(resolveOptions({}), {
    maxTokens: 8_000,
    timeout: 120,
  });
});

test("timeouts must be positive and finite", () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveOptions({}, { timeout }), /positive finite number/);
  }
});

test("maxTokens must be a positive integer", () => {
  for (const maxTokens of [0, -1, 1.5]) {
    assert.throws(() => resolveOptions({}, { maxTokens }), /positive integer/);
  }
});
