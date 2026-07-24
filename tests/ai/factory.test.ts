import assert from "node:assert/strict";
import test from "node:test";

import { createStreamFn } from "../../src/ai/factory.js";
import { testModel } from "./fixtures.js";

test("no provider configured rejects", () => {
  assert.throws(
    () => createStreamFn({ env: {} }),
    /No LLM provider configured/,
  );
});

test("single API key registers the provider", () => {
  const { stream, defaultModel } = createStreamFn({ env: { ANTHROPIC_API_KEY: "key", MODEL_ID: "m" } });
  assert.equal(typeof stream, "function");
  assert.deepEqual(defaultModel, { provider: "anthropic", model: "m" });
});

test("multiple providers configured rejects", () => {
  assert.throws(
    () => createStreamFn({ env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", MODEL_ID: "m" } }),
    /Multiple LLM providers configured/,
  );
});

test("explicit provider config registers custom adapter", () => {
  const { stream } = createStreamFn({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() { yield { type: "done" as const, message: { role: "assistant" as const, content: [], model: "t", stopReason: "stop" as const, latencyMs: 0 } }; },
      }),
    }],
    env: { TEST_KEY: "k", MODEL_ID: "m" },
  });
  assert.equal(typeof stream, "function");
});

test("unknown provider rejects at stream time", async () => {
  const { stream } = createStreamFn({ env: { ANTHROPIC_API_KEY: "k", MODEL_ID: "m" } });
  await assert.rejects(
    (async () => { for await (const _ of stream({ provider: "nonexistent", model: "m" }, { messages: [] })) void _; })(),
    /Unknown provider/,
  );
});
