import assert from "node:assert/strict";
import test from "node:test";

import { createStreamFn, lazyAdapter } from "../../src/ai/factory.js";
import type { ProviderConfig } from "../../src/ai/factory.js";

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

test("multiple providers require DEFAULT_PROVIDER", () => {
  assert.throws(
    () => createStreamFn({ env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", MODEL_ID: "m" } }),
    /DEFAULT_PROVIDER/,
  );
});

test("DEFAULT_PROVIDER selects the default from configured providers", () => {
  const { defaultModel } = createStreamFn({
    env: {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      DEFAULT_PROVIDER: "openai",
      MODEL_ID: "gpt-test",
    },
  });
  assert.deepEqual(defaultModel, { provider: "openai", model: "gpt-test" });
});

test("DEFAULT_PROVIDER must name a configured provider", () => {
  assert.throws(
    () => createStreamFn({
      env: {
        ANTHROPIC_API_KEY: "a",
        DEFAULT_PROVIDER: "openai",
        MODEL_ID: "m",
      },
    }),
    /DEFAULT_PROVIDER.*openai.*not configured/,
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

test("one StreamFn routes each request by model.provider", async () => {
  const calls: string[] = [];
  const provider = (id: string, envApiKey: string): ProviderConfig => ({
    id,
    envApiKey,
    createAdapter: () => ({
      async *stream(model) {
        calls.push(`${id}/${model}`);
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [],
            model,
            stopReason: "stop",
            latencyMs: 0,
          },
        };
      },
    }),
  });

  const { stream } = createStreamFn({
    providers: [
      provider("first", "FIRST_KEY"),
      provider("second", "SECOND_KEY"),
    ],
    env: {
      FIRST_KEY: "a",
      SECOND_KEY: "b",
      DEFAULT_PROVIDER: "first",
      MODEL_ID: "default",
    },
  });

  for await (const event of stream(
    { provider: "first", model: "one" },
    { messages: [] },
  )) void event;
  for await (const event of stream(
    { provider: "second", model: "two" },
    { messages: [] },
  )) void event;

  assert.deepEqual(calls, ["first/one", "second/two"]);
});

test("lazy adapter reuses the loaded adapter across stream calls", async () => {
  let loads = 0;
  const adapter = lazyAdapter(async () => {
    loads += 1;
    return {
      async *stream(model) {
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [],
            model,
            stopReason: "stop",
            latencyMs: 0,
          },
        };
      },
    };
  });

  for await (const event of adapter.stream(
    "one",
    { messages: [] },
    { timeout: 120, maxTokens: 8000 },
  )) void event;
  for await (const event of adapter.stream(
    "two",
    { messages: [] },
    { timeout: 120, maxTokens: 8000 },
  )) void event;

  assert.equal(loads, 1);
});

test("lazy adapter loads on iteration and forwards failures", async () => {
  const failure = new Error("load failed");
  let loads = 0;
  const adapter = lazyAdapter(async () => {
    loads += 1;
    throw failure;
  });

  const stream = adapter.stream(
    "model",
    { messages: [] },
    { timeout: 120, maxTokens: 8000 },
  );
  assert.equal(loads, 0);

  await assert.rejects(
    (async () => {
      for await (const event of stream) void event;
    })(),
    (error) => error === failure,
  );
  assert.equal(loads, 1);
});
