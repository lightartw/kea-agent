import assert from "node:assert/strict";
import test from "node:test";

import { createStreamFn } from "../../src/ai/factory.js";
import { testModel } from "./fixtures.js";

test("no provider configured rejects", () => {
  const fn = createStreamFn({ env: {} });
  assert.rejects(
    (async () => { for await (const _ of fn(testModel, { messages: [] })) void _; })(),
    /Unknown provider/,
  );
});

test("single API key registers the provider", async () => {
  const env = { ANTHROPIC_API_KEY: "key", MODEL_ID: "m" };
  const fn = createStreamFn({ env });
  assert.equal(typeof fn, "function");
});

test("explicit provider config registers custom adapter", () => {
  const fn = createStreamFn({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() { yield { type: "done", message: { role: "assistant", content: [], model: "t", stopReason: "stop", latencyMs: 0 } }; },
      }),
    }],
    env: { TEST_KEY: "k" },
  });
  assert.equal(typeof fn, "function");
});

test("unknown provider rejects at stream time", () => {
  const fn = createStreamFn({ env: { ANTHROPIC_API_KEY: "k" } });
  assert.rejects(
    (async () => { for await (const _ of fn({ provider: "nonexistent", model: "m" }, { messages: [] })) void _; })(),
    /Unknown provider/,
  );
});
