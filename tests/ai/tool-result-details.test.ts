import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/core/ai/adapters/anthropic.js";
import { OpenAIAdapter } from "../../src/core/ai/adapters/openai.js";
import { GeminiAdapter } from "../../src/core/ai/adapters/gemini.js";
import type { ResolvedOptions } from "../../src/core/ai/factory.js";
import type { Context } from "../../src/core/ai/types.js";
import { detailedToolResult } from "./fixtures.js";

const options: ResolvedOptions = { timeout: 120, maxTokens: 8000 };
const context: Context = { messages: [detailedToolResult] };

async function exhaust<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function emptyIterable(): AsyncIterable<unknown> {
  return (async function* () {})();
}

test("Anthropic adapter omits tool result details from the wire", async () => {
  const adapter = new AnthropicAdapter("test-key", null);
  const captured: unknown[] = [];
  const create = async (request: unknown): Promise<AsyncIterable<unknown>> => {
    captured.push(request);
    return emptyIterable();
  };
  Object.defineProperty(adapter, "sdk", {
    configurable: true,
    value: { messages: { create } },
  });

  await exhaust(adapter.stream("test-model", context, options));

  const wire = JSON.stringify(captured[0]);
  assert.match(wire, /Current tasks/);
  assert.doesNotMatch(wire, /must-not-reach-provider/);
  assert.doesNotMatch(wire, /privateMarker/);
});

test("OpenAI adapter omits tool result details from the wire", async () => {
  const adapter = new OpenAIAdapter("test-key", null);
  const captured: unknown[] = [];
  const create = async (request: unknown): Promise<AsyncIterable<unknown>> => {
    captured.push(request);
    return emptyIterable();
  };
  Object.defineProperty(adapter, "sdk", {
    configurable: true,
    value: { chat: { completions: { create } } },
  });

  await exhaust(adapter.stream("test-model", context, options));

  const wire = JSON.stringify(captured[0]);
  assert.match(wire, /Current tasks/);
  assert.doesNotMatch(wire, /must-not-reach-provider/);
  assert.doesNotMatch(wire, /privateMarker/);
});

test("Gemini adapter omits tool result details from the wire", async () => {
  const adapter = new GeminiAdapter("test-key", null);
  const captured: unknown[] = [];
  const generateContentStream = async (request: unknown): Promise<AsyncIterable<unknown>> => {
    captured.push(request);
    return emptyIterable();
  };
  Object.defineProperty(adapter, "sdk", {
    configurable: true,
    value: { models: { generateContentStream } },
  });

  await exhaust(adapter.stream("test-model", context, options));

  const wire = JSON.stringify(captured[0]);
  assert.match(wire, /Current tasks/);
  assert.doesNotMatch(wire, /must-not-reach-provider/);
  assert.doesNotMatch(wire, /privateMarker/);
});
