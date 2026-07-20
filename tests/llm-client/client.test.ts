import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeOptions,
  validateMessages,
  validateTools,
} from "../../src/llm-client/client.js";
import { LLMConfigurationError } from "../../src/llm-client/errors.js";

test("call options override defaults", () => {
  const controller = new AbortController();
  const options = mergeOptions(
    { maxTokens: 4_096, timeout: 60 },
    { maxTokens: 7, signal: controller.signal },
  );

  assert.equal(options.maxTokens, 7);
  assert.equal(options.timeout, 60);
  assert.equal(options.signal, controller.signal);
});

test("unknown runtime options are rejected", () => {
  assert.throws(
    () => mergeOptions({}, { providerPrivate: true } as never),
    LLMConfigurationError,
  );
});

test("client defaults cannot retain an abort signal", () => {
  const controller = new AbortController();
  assert.throws(
    () => mergeOptions({ signal: controller.signal } as never),
    /Unknown LLM option: signal/,
  );
});

test("timeouts must be positive and finite", () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mergeOptions({}, { timeout }), /positive finite number/);
  }
});

test("timeouts must fit the Node AbortSignal timer range", () => {
  assert.doesNotThrow(() => mergeOptions({}, { timeout: 1.2345 }));
  assert.throws(
    () => mergeOptions({}, { timeout: 2_147_483.648 }),
    /Node timer range/,
  );
});

test("assistant tool arguments must be objects", () => {
  assert.throws(
    () =>
      validateMessages([
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "1", name: "bash", arguments: [] as never },
          ],
        },
      ]),
    /arguments must be an object/,
  );
});

test("function tools require an object parameter schema", () => {
  assert.throws(
    () =>
      validateTools([
        {
          type: "function",
          function: {
            name: "bad",
            description: "bad",
            parameters: { type: "string" } as never,
          },
        },
      ]),
    /parameters.type must be object/,
  );
});

test("messages must not be empty", () => {
  assert.throws(() => validateMessages([]), LLMConfigurationError);
});
