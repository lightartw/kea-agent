import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicAdapter } from "../../src/llm-client/adapters/anthropic.js";
import { baseConfig } from "./fixtures.js";

test("Anthropic adapter exposes the common client interface", () => {
  const client = createAnthropicAdapter(baseConfig);
  assert.equal(typeof client.invoke, "function");
  assert.equal(typeof client.stream, "function");
});
