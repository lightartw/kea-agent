import assert from "node:assert/strict";
import test from "node:test";

import { createGeminiAdapter } from "../../src/llm-client/adapters/gemini.js";
import { baseConfig } from "./fixtures.js";

test("Gemini adapter exposes the common client interface", () => {
  const client = createGeminiAdapter(baseConfig);
  assert.equal(typeof client.invoke, "function");
  assert.equal(typeof client.stream, "function");
});
