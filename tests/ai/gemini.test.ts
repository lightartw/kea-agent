import assert from "node:assert/strict";
import test from "node:test";

import { GeminiAdapter } from "../../src/core/ai/adapters/gemini.js";

test("Gemini adapter exposes stream interface", () => {
  const adapter = new GeminiAdapter("test-key", null);
  assert.equal(typeof adapter.stream, "function");
});
