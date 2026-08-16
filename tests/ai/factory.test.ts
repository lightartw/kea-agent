import assert from "node:assert/strict";
import test from "node:test";

import { createModelRuntime, lazyAdapter } from "../../src/core/ai/factory.js";
import type { ProviderConfig } from "../../src/core/ai/factory.js";
import type { AssistantMessage } from "../../src/core/ai/types.js";

test("no provider configured rejects", () => {
  assert.throws(
    () => createModelRuntime({ env: {} }),
    /No LLM provider configured/,
  );
});

test("single API key registers the provider", () => {
  const { runtime, modelConfig } = createModelRuntime({ env: { ANTHROPIC_API_KEY: "key", MODEL_ID: "m" } });
  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
  assert.deepEqual(modelConfig, { provider: "anthropic", model: "m" });
});

test("multiple providers require DEFAULT_PROVIDER", () => {
  assert.throws(
    () => createModelRuntime({ env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", MODEL_ID: "m" } }),
    /DEFAULT_PROVIDER/,
  );
});

test("DEFAULT_PROVIDER selects the default from configured providers", () => {
  const { modelConfig } = createModelRuntime({
    env: {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      DEFAULT_PROVIDER: "openai",
      MODEL_ID: "gpt-test",
    },
  });
  assert.deepEqual(modelConfig, { provider: "openai", model: "gpt-test" });
});

test("DEFAULT_PROVIDER must name a configured provider", () => {
  assert.throws(
    () => createModelRuntime({
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
  const { runtime } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() { yield { type: "done" as const, message: { role: "assistant" as const, content: [], model: "t", stopReason: "stop" as const, latencyMs: 0 } }; },
      }),
    }],
    env: { TEST_KEY: "k", MODEL_ID: "m" },
  });
  assert.equal(typeof runtime.stream, "function");
});

test("unknown provider rejects at stream time", async () => {
  const { runtime } = createModelRuntime({ env: { ANTHROPIC_API_KEY: "k", MODEL_ID: "m" } });
  await assert.rejects(
    (async () => { for await (const _ of runtime.stream({ provider: "nonexistent", model: "m" }, { messages: [] })) void _; })(),
    /Unknown provider/,
  );
});

test("one ModelRuntime routes each request by model.provider", async () => {
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

  const { runtime } = createModelRuntime({
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

  for await (const event of runtime.stream(
    { provider: "first", model: "one" },
    { messages: [] },
  )) void event;
  for await (const event of runtime.stream(
    { provider: "second", model: "two" },
    { messages: [] },
  )) void event;

  assert.deepEqual(calls, ["first/one", "second/two"]);
});

test("complete returns the terminal assistant message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "test-model",
    stopReason: "stop",
    latencyMs: 0,
  };
  const { runtime, modelConfig } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() {
          yield { type: "text_delta" as const, text: "done" };
          yield { type: "done" as const, message: terminal };
        },
      }),
    }],
    env: { TEST_KEY: "key", MODEL_ID: "test-model" },
  });

  assert.equal(
    await runtime.complete(modelConfig, { messages: [] }),
    terminal,
  );
});

test("complete returns an error terminal message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [],
    model: "test-model",
    stopReason: "error",
    errorMessage: "provider failed",
    latencyMs: 0,
  };
  const { runtime, modelConfig } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() {
          yield { type: "error" as const, message: terminal };
        },
      }),
    }],
    env: { TEST_KEY: "key", MODEL_ID: "test-model" },
  });

  assert.equal(
    await runtime.complete(modelConfig, { messages: [] }),
    terminal,
  );
});

test("complete rejects when the stream has no terminal chunk", async () => {
  const { runtime, modelConfig } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() {
          yield { type: "text_delta" as const, text: "partial" };
        },
      }),
    }],
    env: { TEST_KEY: "key", MODEL_ID: "test-model" },
  });

  await assert.rejects(
    runtime.complete(modelConfig, { messages: [] }),
    /without a done or error terminal chunk/,
  );
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
