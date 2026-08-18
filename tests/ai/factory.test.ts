import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelRuntime,
  createModelRuntimeFromEnvironment,
  createRoutedRuntime,
  lazyAdapter,
} from "../../src/core/ai/factory.js";
import type { AssistantMessage } from "../../src/core/ai/types.js";
import type { ProtocolId } from "../../src/core/ai/factory.js";

test("explicit provider configuration is required and unique", () => {
  assert.throws(
    () => createModelRuntime({ providers: [] }),
    /at least one provider/i,
  );
  assert.throws(
    () => createModelRuntime({
      providers: [
        { name: "openai", protocol: "openai", apiKey: "a" },
        { name: "openai", protocol: "openai", apiKey: "b" },
      ],
    }),
    /duplicate provider.*openai/i,
  );
});

test("unknown protocols are rejected", () => {
  assert.throws(
    () => createModelRuntime({
      providers: [{ name: "custom", protocol: "watson" as ProtocolId, apiKey: "a" }],
    }),
    /unknown protocol.*watson/i,
  );
});

test("explicit providers construct a runtime", () => {
  const runtime = createModelRuntime({ providers: [{ name: "openai", protocol: "openai", apiKey: "key" }] });
  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
});

test("two providers may share one protocol", () => {
  const runtime = createModelRuntime({
    providers: [
      { name: "deepseek", protocol: "openai", apiKey: "a" },
      { name: "ollama", protocol: "openai", apiKey: "b" },
    ],
  });
  assert.equal(typeof runtime.stream, "function");
});

test("routed runtime selects the adapter and forwards the model", async () => {
  const calls: string[] = [];
  const adapter = (id: string) => ({
    async *stream(model: string) {
      calls.push(`${id}/${model}`);
      yield {
        type: "done" as const,
        message: {
          role: "assistant" as const,
          content: [],
          model,
          stopReason: "stop" as const,
          latencyMs: 0,
        },
      };
    },
  });
  const runtime = createRoutedRuntime(new Map([
    ["openai", adapter("openai")],
    ["anthropic", adapter("anthropic")],
  ]));

  for await (const event of runtime.stream(
    { provider: "anthropic", model: "claude-test" },
    { messages: [] },
  )) void event;

  assert.deepEqual(calls, ["anthropic/claude-test"]);
});

test("routed runtime rejects unknown providers at stream time", async () => {
  const runtime = createRoutedRuntime(new Map());
  await assert.rejects(
    (async () => {
      for await (const event of runtime.stream(
        { provider: "nonexistent", model: "m" },
        { messages: [] },
      )) void event;
    })(),
    /Unknown provider/,
  );
});

test("environment helper does not select a model", () => {
  const runtime = createModelRuntimeFromEnvironment({ OPENAI_API_KEY: "key" });
  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
});

test("environment helper requires at least one provider key", () => {
  assert.throws(
    () => createModelRuntimeFromEnvironment({}),
    /at least one provider/i,
  );
});

test("environment helper ignores DEFAULT_PROVIDER and MODEL_ID", () => {
  const runtime = createModelRuntimeFromEnvironment({
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "b",
    DEFAULT_PROVIDER: "anthropic",
    MODEL_ID: "m",
  });
  assert.equal(typeof runtime.stream, "function");
});

test("complete returns the terminal assistant message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "test-model",
    stopReason: "stop",
    latencyMs: 0,
  };
  const runtime = createRoutedRuntime(new Map([
    ["test", {
      async *stream() {
        yield { type: "text_delta" as const, text: "done" };
        yield { type: "done" as const, message: terminal };
      },
    }],
  ]));

  assert.equal(
    await runtime.complete({ provider: "test", model: "test-model" }, { messages: [] }),
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
  const runtime = createRoutedRuntime(new Map([
    ["test", {
      async *stream() {
        yield { type: "error" as const, message: terminal };
      },
    }],
  ]));

  assert.equal(
    await runtime.complete({ provider: "test", model: "test-model" }, { messages: [] }),
    terminal,
  );
});

test("complete rejects when the stream has no terminal chunk", async () => {
  const runtime = createRoutedRuntime(new Map([
    ["test", {
      async *stream() {
        yield { type: "text_delta" as const, text: "partial" };
      },
    }],
  ]));

  await assert.rejects(
    runtime.complete({ provider: "test", model: "test-model" }, { messages: [] }),
    /without a done or error terminal chunk/,
  );
});

test("lazy adapter reuses the loaded adapter across stream calls", async () => {
  let loads = 0;
  const adapter = lazyAdapter(async () => {
    loads += 1;
    return {
      async *stream(model: string) {
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [],
            model,
            stopReason: "stop" as const,
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
