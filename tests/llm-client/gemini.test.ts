import assert from "node:assert/strict";
import test from "node:test";

import { GeminiAdapter } from "../../src/llm-client/adapters/gemini.js";
import { baseConfig } from "./fixtures.js";

test("Gemini adapter exposes the v2 stream-only client interface", () => {
  const client = new GeminiAdapter(baseConfig);
  assert.equal(typeof client.stream, "function");
});
