import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIAdapter } from "../../src/core/ai/adapters/openai.js";
import type { StreamChunk } from "../../src/core/ai/types.js";

test("OpenAI adapter exposes stream interface", () => {
  const adapter = new OpenAIAdapter("test-key", null);
  assert.equal(typeof adapter.stream, "function");
});

/** Adapter with a stubbed SDK; only the stream path is under test. */
function stubbedAdapter(): {
  readonly stream: OpenAIAdapter["stream"];
  readonly sdk: {
    chat: {
      completions: {
        create: (stream: AsyncIterable<unknown>) => Promise<AsyncIterable<unknown>>;
      };
    };
  };
} {
  const adapter = new OpenAIAdapter("test-key", null) as unknown as {
    stream: OpenAIAdapter["stream"];
    sdk: {
      chat: {
        completions: {
          create: () => Promise<AsyncIterable<unknown>>;
        };
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

test("OpenAI adapter closes streamed tool calls with toolcall_end before done", async () => {
  const { stream, sdk } = stubbedAdapter();
  sdk.chat.completions.create = async () => (async function* () {
    yield {
      id: "c1",
      model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: "" } }],
        },
      }],
    };
    yield {
      id: "c2",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\": \"pwd\"}" } }] },
      }],
    };
    yield {
      id: "c3",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    };
    yield { id: "c4", usage: { prompt_tokens: 10, completion_tokens: 5 } };
  })();

  const chunks = await collect(
    stream("deepseek-v4-flash", { systemPrompt: "", messages: [] }, { timeout: 30, maxTokens: 256 }),
  );

  const end = chunks.find((chunk) => chunk.type === "toolcall_end");
  assert.ok(end !== undefined && end.type === "toolcall_end");
  assert.deepEqual(end.toolCall, {
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: { command: "pwd" },
  });
  const endIndex = chunks.findIndex((chunk) => chunk.type === "toolcall_end");
  const doneIndex = chunks.findIndex((chunk) => chunk.type === "done");
  assert.ok(endIndex >= 0 && endIndex < doneIndex, "toolcall_end must precede done");
  assert.equal(chunks.filter((chunk) => chunk.type === "toolcall_end").length, 1);
});
