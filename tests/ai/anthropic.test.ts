import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/ai/adapters/anthropic.js";

test("Anthropic adapter exposes stream interface", () => {
  const adapter = new AnthropicAdapter("test-key", null);
  assert.equal(typeof adapter.stream, "function");
});
