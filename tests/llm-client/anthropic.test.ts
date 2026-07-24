import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/llm-client/adapters/anthropic.js";
import { baseConfig } from "./fixtures.js";

test("Anthropic adapter exposes the v2 stream-only client interface", () => {
  const client = new AnthropicAdapter(baseConfig);
  assert.equal(typeof client.stream, "function");
});
