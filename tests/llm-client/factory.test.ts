import assert from "node:assert/strict";
import test from "node:test";

import type {
  AdapterConfig,
  LLMClient,
} from "../../src/llm-client/client.js";
import {
  createLLMClient,
  type AdapterLoaders,
} from "../../src/llm-client/factory.js";
import {
  LLMConfigurationError,
  LLMProviderError,
} from "../../src/llm-client/errors.js";
import {
  fakeClient,
  textResponse,
  userMessages,
} from "./fixtures.js";

function loadersFor(
  provider: "anthropic" | "openai" | "gemini",
  loader: (config: AdapterConfig) => Promise<LLMClient>,
): AdapterLoaders {
  const wrong = async (): Promise<LLMClient> => {
    throw new Error("wrong loader");
  };
  return {
    anthropic: provider === "anthropic" ? loader : wrong,
    openai: provider === "openai" ? loader : wrong,
    gemini: provider === "gemini" ? loader : wrong,
  };
}

test("automatic detection requires exactly one provider marker", () => {
  assert.throws(
    () => createLLMClient({}, {}, loadersFor("anthropic", async () => fakeClient)),
    /No LLM provider configured/,
  );
  assert.throws(
    () =>
      createLLMClient(
        {},
        { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", MODEL_ID: "m" },
        loadersFor("anthropic", async () => fakeClient),
      ),
    /Multiple LLM providers configured: anthropic, openai/,
  );
});

test("automatic detection resolves model, key, and base URL", async () => {
  let received: AdapterConfig | undefined;
  const client = createLLMClient(
    { maxTokens: 33 },
    {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://openai.example.test",
      MODEL_ID: "env-model",
    },
    loadersFor("openai", async (config) => {
      received = config;
      return fakeClient;
    }),
  );

  assert.equal(received, undefined);
  await client.invoke(userMessages);
  assert.deepEqual(received, {
    model: "env-model",
    apiKey: "env-key",
    baseUrl: "https://openai.example.test",
    defaultOptions: { timeout: 120, maxTokens: 33 },
  });
});

test("explicit provider bypasses detection and explicit values win", async () => {
  let received: AdapterConfig | undefined;
  const client = createLLMClient(
    {
      provider: "anthropic",
      model: "explicit-model",
      apiKey: "explicit-key",
      baseUrl: "https://explicit.example.test",
    },
    {
      ANTHROPIC_API_KEY: "env-anthropic",
      OPENAI_API_KEY: "env-openai",
      MODEL_ID: "env-model",
      ANTHROPIC_BASE_URL: "https://env.example.test",
    },
    loadersFor("anthropic", async (config) => {
      received = config;
      return fakeClient;
    }),
  );

  await client.invoke(userMessages);
  assert.equal(received?.model, "explicit-model");
  assert.equal(received?.apiKey, "explicit-key");
  assert.equal(received?.baseUrl, "https://explicit.example.test");
});

test("an explicit null base URL disables the environment override", async () => {
  let received: AdapterConfig | undefined;
  const client = createLLMClient(
    {
      provider: "openai",
      model: "model",
      apiKey: "key",
      baseUrl: null,
    },
    { OPENAI_BASE_URL: "https://env.example.test" },
    loadersFor("openai", async (config) => {
      received = config;
      return fakeClient;
    }),
  );

  await client.invoke(userMessages);
  assert.equal(received?.baseUrl, null);
});

test("missing model and selected API key fail synchronously", () => {
  const loaders = loadersFor("gemini", async () => fakeClient);
  assert.throws(
    () =>
      createLLMClient(
        { provider: "gemini", apiKey: "key" },
        {},
        loaders,
      ),
    /Missing model/,
  );
  assert.throws(
    () =>
      createLLMClient(
        { provider: "gemini", model: "model" },
        {},
        loaders,
      ),
    /GEMINI_API_KEY/,
  );
});

test("unsupported providers fail synchronously", () => {
  assert.throws(
    () =>
      createLLMClient(
        { provider: "unknown" } as never,
        {},
        loadersFor("anthropic", async () => fakeClient),
      ),
    LLMConfigurationError,
  );
});

test("concurrent first calls share one adapter loader", async () => {
  let loads = 0;
  const loaders = loadersFor("anthropic", async () => {
    loads += 1;
    await Promise.resolve();
    return fakeClient;
  });
  const client = createLLMClient(
    { provider: "anthropic", model: "m", apiKey: "k" },
    {},
    loaders,
  );

  await Promise.all([
    client.invoke(userMessages),
    client.invoke(userMessages),
  ]);
  assert.equal(loads, 1);
});

test("only the selected loader is called", async () => {
  const calls: string[] = [];
  const loaders: AdapterLoaders = {
    anthropic: async () => {
      calls.push("anthropic");
      return fakeClient;
    },
    openai: async () => {
      calls.push("openai");
      return fakeClient;
    },
    gemini: async () => {
      calls.push("gemini");
      return fakeClient;
    },
  };
  const client = createLLMClient(
    { provider: "gemini", model: "m", apiKey: "k" },
    {},
    loaders,
  );
  await client.invoke(userMessages);
  assert.deepEqual(calls, ["gemini"]);
});

test("loader failures are memoized and wrapped with their cause", async () => {
  const cause = new Error("module unavailable");
  let loads = 0;
  const client = createLLMClient(
    { provider: "openai", model: "m", apiKey: "k" },
    {},
    loadersFor("openai", async () => {
      loads += 1;
      throw cause;
    }),
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      client.invoke(userMessages),
      (error: unknown) =>
        error instanceof LLMProviderError && error.cause === cause,
    );
  }
  assert.equal(loads, 1);
});

test("lazy client delegates streaming", async () => {
  const client = createLLMClient(
    { provider: "anthropic", model: "m", apiKey: "k" },
    {},
    loadersFor("anthropic", async () => fakeClient),
  );
  const chunks: string[] = [];
  for await (const chunk of client.streamInvoke(userMessages)) chunks.push(chunk);
  assert.deepEqual(chunks, [textResponse.content]);
});
