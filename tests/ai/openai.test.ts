import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIAdapter } from "../../src/ai/adapters/openai.js";

test("OpenAI adapter exposes stream interface", () => {
  const adapter = new OpenAIAdapter("test-key", null);
  assert.equal(typeof adapter.stream, "function");
});
