import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/core/ai/adapters/anthropic.js";
import type { StreamChunk } from "../../src/core/ai/types.js";

test("Anthropic adapter exposes stream interface", () => {
  const adapter = new AnthropicAdapter("test-key", null);
  assert.equal(typeof adapter.stream, "function");
});

/** Adapter with a stubbed SDK; only the stream path is under test. */
function stubbedAdapter(): {
  readonly stream: AnthropicAdapter["stream"];
  readonly sdk: {
    messages: {
      create: (stream: AsyncIterable<unknown>) => Promise<AsyncIterable<unknown>>;
    };
  };
} {
  const adapter = new AnthropicAdapter("test-key", null) as unknown as {
    stream: AnthropicAdapter["stream"];
    sdk: {
      messages: {
        create: () => Promise<AsyncIterable<unknown>>;
      };
    };
  };
  return {
    stream: adapter.stream.bind(adapter),
    sdk: adapter.sdk,
  };
}
async function collect(
  stream: AsyncIterable<StreamChunk>,
): Promise<readonly StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("Anthropic adapter closes tool_use blocks that never get content_block_stop", async () => {
  const { stream, sdk } = stubbedAdapter();
  sdk.messages.create = async () => (async function* () {
    yield { type: "message_start", message: { model: "deepseek-v4-flash", usage: { input_tokens: 10 } } };
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu-1", name: "bash", input: {} },
    };
    yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: " \"pwd\"}" } };
    yield { type: "message_delta", delta: { stop_reason: "tool_use" } };
  })();

  const chunks = await collect(
    stream("deepseek-v4-flash", { systemPrompt: "", messages: [] }, { timeout: 30, maxTokens: 256 }),
  );

  const end = chunks.find((chunk) => chunk.type === "toolcall_end");
  assert.ok(end !== undefined && end.type === "toolcall_end");
  assert.deepEqual(end.toolCall, {
    type: "toolCall",
    id: "toolu-1",
    name: "bash",
    arguments: { command: "pwd" },
  });
  const endIndex = chunks.findIndex((chunk) => chunk.type === "toolcall_end");
  const doneIndex = chunks.findIndex((chunk) => chunk.type === "done");
  assert.ok(endIndex >= 0 && endIndex < doneIndex, "toolcall_end must precede done");
  assert.equal(chunks.filter((chunk) => chunk.type === "toolcall_end").length, 1);
});

test("Anthropic adapter emits each closed tool_use exactly once", async () => {
  const { stream, sdk } = stubbedAdapter();
  sdk.messages.create = async () => (async function* () {
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu-1", name: "bash", input: {} },
    };
    yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", delta: { stop_reason: "tool_use" } };
  })();

  const chunks = await collect(
    stream("deepseek-v4-flash", { systemPrompt: "", messages: [] }, { timeout: 30, maxTokens: 256 }),
  );

  assert.equal(chunks.filter((chunk) => chunk.type === "toolcall_end").length, 1);
  const done = chunks.find((chunk) => chunk.type === "done");
  assert.ok(done !== undefined && done.type === "done");
  assert.equal(done.message.stopReason, "toolUse");
});
