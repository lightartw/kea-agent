import assert from "node:assert/strict";
import test from "node:test";

import {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "@anthropic-ai/sdk";

import { AnthropicAdapter } from "../../src/llm-client/adapters/anthropic.js";
import {
  LLMProviderError,
  LLMTimeoutError,
} from "../../src/llm-client/errors.js";
import type { LLMStreamEvent } from "../../src/llm-client/models.js";
import {
  asyncItems,
  baseConfig,
  bashSchema,
  commonHistory,
  userMessages,
} from "./fixtures.js";

class FakeAnthropicClient {
  lastRequest: any;
  lastRequestOptions: any;

  constructor(private readonly response: unknown) {}

  readonly messages = {
    create: async (request: any, requestOptions: any): Promise<unknown> => {
      this.lastRequest = request;
      this.lastRequestOptions = requestOptions;
      if (this.response instanceof Error) throw this.response;
      return this.response;
    },
  };
}

const basicResponse = {
  model: "claude-test",
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 4 },
  content: [{ type: "text", text: "done" }],
};

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("Anthropic converts system messages, schemas, and tool results", async () => {
  const fake = new FakeAnthropicClient(basicResponse);
  const response = await new AnthropicAdapter(baseConfig, fake).invoke(
    commonHistory,
    [bashSchema],
  );

  assert.equal(fake.lastRequest.system, "system one\n\nsystem two");
  assert.deepEqual(fake.lastRequest.tools, [{
    name: "bash",
    description: "Run a shell command.",
    input_schema: bashSchema.function.parameters,
  }]);
  assert.deepEqual(fake.lastRequest.messages.at(-1), {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }],
  });
  assert.deepEqual(response.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
});

test("Anthropic normalizes tool calls and maps options", async () => {
  const fake = new FakeAnthropicClient({
    model: "claude-test",
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 2 },
    content: [
      { type: "text", text: "working" },
      { type: "tool_use", id: "c1", name: "bash", input: { command: "pwd" } },
    ],
  });
  const response = await new AnthropicAdapter(baseConfig, fake).invoke(
    userMessages,
    undefined,
    { maxTokens: 17, temperature: 0.2, topP: 0.8, stop: ["END"] },
  );

  assert.equal(fake.lastRequest.max_tokens, 17);
  assert.equal(fake.lastRequest.temperature, 0.2);
  assert.equal(fake.lastRequest.top_p, 0.8);
  assert.deepEqual(fake.lastRequest.stop_sequences, ["END"]);
  assert.deepEqual(response.toolCalls, [
    { id: "c1", name: "bash", arguments: { command: "pwd" } },
  ]);
  assert.equal(response.finishReason, "tool_calls");
});

test("Anthropic rejects non-object provider tool arguments", async () => {
  const fake = new FakeAnthropicClient({
    ...basicResponse,
    content: [{ type: "tool_use", id: "c1", name: "bash", input: [] }],
  });
  await assert.rejects(
    new AnthropicAdapter(baseConfig, fake).invoke(userMessages),
    LLMProviderError,
  );
});

test("Anthropic maps authentication and timeout failures", async () => {
  const authentication = Object.create(AuthenticationError.prototype) as Error;
  const timeout = Object.create(APIConnectionTimeoutError.prototype) as Error;

  await assert.rejects(
    new AnthropicAdapter(baseConfig, new FakeAnthropicClient(authentication)).invoke(userMessages),
    (error: unknown) =>
      error instanceof LLMProviderError && /authentication/.test(error.message),
  );
  await assert.rejects(
    new AnthropicAdapter(baseConfig, new FakeAnthropicClient(timeout)).invoke(userMessages),
    LLMTimeoutError,
  );
});

test("Anthropic enforces the common timeout", async () => {
  const adapter = new AnthropicAdapter(
    { ...baseConfig, options: { timeout: 0.001, maxTokens: 8_000 } },
    new FakeAnthropicClient(new Promise(() => undefined)),
  );
  await assert.rejects(adapter.invoke(userMessages), LLMTimeoutError);
});

test("Anthropic enforces timeout for the full stream", async () => {
  const fake = {
    messages: {
      async create(
        _request: Record<string, unknown>,
        options: { readonly timeout: number; readonly signal: AbortSignal },
      ): Promise<unknown> {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
            if (options.signal.aborted) throw options.signal.reason;
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(options.signal.reason),
                { once: true },
              );
            });
          },
        };
      },
    },
  };
  const adapter = new AnthropicAdapter(
    { ...baseConfig, options: { timeout: 0.001, maxTokens: 8_000 } },
    fake,
  );

  await assert.rejects(collect(adapter.stream(userMessages)), LLMTimeoutError);
});

test("Anthropic wraps generic failures with their cause", async () => {
  const cause = new Error("offline");
  await assert.rejects(
    new AnthropicAdapter(baseConfig, new FakeAnthropicClient(cause)).invoke(userMessages),
    (error: unknown) => error instanceof LLMProviderError && error.cause === cause,
  );
});

test("Anthropic streams text and completes fragmented tool calls", async () => {
  const fake = new FakeAnthropicClient(asyncItems([
    {
      type: "message_start",
      message: { model: "claude-test", usage: { input_tokens: 2 } },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "working" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "c1", name: "bash", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"pwd"}' },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ]));

  const events = await collect(
    new AnthropicAdapter(baseConfig, fake).stream(userMessages, [bashSchema]),
  );

  assert.deepEqual(events[0], { type: "text_delta", text: "working" });
  const done = events[1];
  assert.equal(done?.type, "response_done");
  if (done?.type !== "response_done") return;
  assert.equal(done.response.content, "working");
  assert.deepEqual(done.response.toolCalls, [
    { id: "c1", name: "bash", arguments: { command: "pwd" } },
  ]);
  assert.deepEqual(done.response.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
  assert.equal(done.response.finishReason, "tool_calls");
  assert.deepEqual(fake.lastRequest.tools[0].input_schema, bashSchema.function.parameters);
});

test("Anthropic normalizes malformed streamed tool arguments", async () => {
  const fake = new FakeAnthropicClient(asyncItems([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "c1", name: "bash", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    },
  ]));

  await assert.rejects(
    collect(new AnthropicAdapter(baseConfig, fake).stream(userMessages, [bashSchema])),
    LLMProviderError,
  );
});
