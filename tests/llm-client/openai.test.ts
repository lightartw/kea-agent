import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIAdapter } from "../../src/llm-client/adapters/openai.js";
import { baseConfig } from "./fixtures.js";

test("OpenAI adapter exposes the common client interface", () => {
  const client = createOpenAIAdapter(baseConfig);
  assert.equal(typeof client.invoke, "function");
  assert.equal(typeof client.stream, "function");
});
