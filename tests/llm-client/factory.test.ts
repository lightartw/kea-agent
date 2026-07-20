import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/llm-client/adapters/anthropic.js";
import { GeminiAdapter } from "../../src/llm-client/adapters/gemini.js";
import { OpenAIAdapter } from "../../src/llm-client/adapters/openai.js";
import { LLMConfigurationError } from "../../src/llm-client/errors.js";
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

test("automatic detection creates the selected adapter with environment config", async () => {
  const client = await createLLMClient(
    { maxTokens: 33 },
    {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://openai.example.test",
      MODEL_ID: "env-model",
    },
  );

  assert.ok(client instanceof OpenAIAdapter);
  assert.deepEqual((client as any).config, {
    model: "env-model",
    apiKey: "env-key",
    baseUrl: "https://openai.example.test",
    defaultOptions: { timeout: 120, maxTokens: 33 },
  });
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

  assert.ok(client instanceof AnthropicAdapter);
  assert.equal((client as any).config.model, "explicit-model");
  assert.equal((client as any).config.apiKey, "explicit-key");
  assert.equal((client as any).config.baseUrl, "https://explicit.example.test");
});

test("an explicit null base URL disables the environment override", async () => {
  const client = await createLLMClient(
    { provider: "gemini", model: "model", apiKey: "key", baseUrl: null },
    { GEMINI_BASE_URL: "https://env.example.test" },
  );

  assert.ok(client instanceof GeminiAdapter);
  assert.equal((client as any).config.baseUrl, null);
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
    LLMConfigurationError,
  );
});
