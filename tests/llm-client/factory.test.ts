import assert from "node:assert/strict";
import test from "node:test";

import { createLLMClient } from "../../src/llm-client/factory.js";

test("automatic detection requires exactly one provider marker", async () => {
  await assert.rejects(createLLMClient({}, {}), /No LLM provider configured/);
  await assert.rejects(
    createLLMClient(
      {},
      { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", MODEL_ID: "m" },
    ),
    /Multiple LLM providers configured: anthropic, openai/,
  );
});

test("automatic detection creates the selected client", async () => {
  const client = await createLLMClient(
    { maxTokens: 33 },
    {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://openai.example.test",
      MODEL_ID: "env-model",
    },
  );

  assert.equal(typeof client.stream, "function");
});

test("explicit provider and values override environment detection", async () => {
  const client = await createLLMClient(
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
  );

  assert.equal(typeof client.stream, "function");
});

test("an explicit null base URL disables the environment override", async () => {
  const client = await createLLMClient(
    { provider: "gemini", model: "model", apiKey: "key", baseUrl: null },
    { GEMINI_BASE_URL: "https://env.example.test" },
  );

  assert.equal(typeof client.stream, "function");
});

test("missing model and selected API key reject creation", async () => {
  await assert.rejects(
    createLLMClient({ provider: "gemini", apiKey: "key" }, {}),
    /Missing model/,
  );
  await assert.rejects(
    createLLMClient({ provider: "gemini", model: "model" }, {}),
    /GEMINI_API_KEY/,
  );
});

test("unsupported providers reject creation", async () => {
  await assert.rejects(
    createLLMClient({ provider: "unknown" } as never, {}),
    Error,
  );
});
