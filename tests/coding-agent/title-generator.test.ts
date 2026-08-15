import assert from "node:assert/strict";
import test from "node:test";

import { createSessionTitleGenerator } from "../../src/coding-agent/title-generator.js";
import type { Context, ModelConfig, StreamFn } from "../../src/core/ai/types.js";

const model: ModelConfig = { provider: "test", model: "model" };

function recordingStream(
  onContext: (context: Context) => void,
): StreamFn {
  return async function* (_model, context) {
    onContext(context);
    yield { type: "text_delta", text: "Parser fix" };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Parser fix" }],
        model: "model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        latencyMs: 0,
      },
    };
  };
}

test("title generator makes one bounded Tool-free request", async () => {
  const seen: Context[] = [];
  const generate = createSessionTitleGenerator(recordingStream((context) => seen.push(context)));

  assert.equal(await generate("fix parser", model), "Parser fix");
  assert.deepEqual(seen[0]?.tools, []);
  assert.deepEqual(seen[0]?.messages, [{ role: "user", content: "fix parser" }]);
});

test("title generator accumulates text deltas", async () => {
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "Par" };
    yield { type: "text_delta", text: "ser fix" };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [],
        model: "model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        latencyMs: 0,
      },
    };
  };
  const generate = createSessionTitleGenerator(stream);
  assert.equal(await generate("fix parser", model), "Parser fix");
});

test("title generator falls back to final assistant text blocks", async () => {
  const stream: StreamFn = async function* () {
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "From final block" }],
        model: "model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        latencyMs: 0,
      },
    };
  };
  const generate = createSessionTitleGenerator(stream);
  assert.equal(await generate("x", model), "From final block");
});

test("title generator rejects when no text exists", async () => {
  const stream: StreamFn = async function* () {
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [],
        model: "model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        latencyMs: 0,
      },
    };
  };
  const generate = createSessionTitleGenerator(stream);
  await assert.rejects(generate("x", model), /no text/);
});
