import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIAdapter } from "../../src/llm-client/adapters/openai.js";
import { baseConfig } from "./fixtures.js";

test("OpenAI adapter exposes the v2 stream-only client interface", () => {
  const client = new OpenAIAdapter(baseConfig);
  assert.equal(typeof client.stream, "function");
});
