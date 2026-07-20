import assert from "node:assert/strict";
import test from "node:test";

import {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "@anthropic-ai/sdk";

import { AnthropicAdapter } from "../../src/llm-client/adapters/anthropic.js";
import {
  LLMAuthenticationError,
  LLMProviderError,
  LLMTimeoutError,
} from "../../src/llm-client/errors.js";
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

test("Anthropic converts system, tool calls, and tool results", async () => {
  const fake = new FakeAnthropicClient(basicResponse);
  const adapter = new AnthropicAdapter(baseConfig, fake);

  const response = await adapter.invokeWithTools(commonHistory, [bashSchema]);

  assert.equal(fake.lastRequest.system, "system one\n\nsystem two");
  assert.deepEqual(
    fake.lastRequest.tools[0].input_schema,
    bashSchema.function.parameters,
  );
  assert.deepEqual(fake.lastRequest.messages, [
    { role: "user", content: "run pwd" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: "/tmp" },
      ],
    },
  ]);
  assert.deepEqual(response, {
    model: "claude-test",
    content: "done",
    toolCalls: [],
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    latencyMs: response.latencyMs,
    finishReason: "stop",
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
  const adapter = new AnthropicAdapter(baseConfig, fake);

  const response = await adapter.invoke(userMessages, {
    maxTokens: 17,
    temperature: 0.2,
    topP: 0.8,
    stop: ["END"],
  });

  assert.equal(fake.lastRequest.max_tokens, 17);
  assert.equal(fake.lastRequest.temperature, 0.2);
  assert.equal(fake.lastRequest.top_p, 0.8);
  assert.deepEqual(fake.lastRequest.stop_sequences, ["END"]);
  assert.deepEqual(response.toolCalls, [
    { id: "c1", name: "bash", arguments: { command: "pwd" } },
  ]);
  assert.equal(response.finishReason, "tool_calls");
});

test("Anthropic maps max-token finish reasons", async () => {
  const fake = new FakeAnthropicClient({ ...basicResponse, stop_reason: "max_tokens" });
  const response = await new AnthropicAdapter(baseConfig, fake).invoke(userMessages);
  assert.equal(response.finishReason, "length");
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

test("Anthropic preserves caller abort reasons", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  const fake = new FakeAnthropicClient(new Promise(() => undefined));

  await assert.rejects(
    new AnthropicAdapter(baseConfig, fake).invoke(userMessages, {
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
});

test("Anthropic translates authentication and timeout errors", async () => {
  const authentication = Object.create(AuthenticationError.prototype) as Error;
  const timeout = Object.create(APIConnectionTimeoutError.prototype) as Error;

  await assert.rejects(
    new AnthropicAdapter(baseConfig, new FakeAnthropicClient(authentication)).invoke(
      userMessages,
    ),
    LLMAuthenticationError,
  );
  await assert.rejects(
    new AnthropicAdapter(baseConfig, new FakeAnthropicClient(timeout)).invoke(
      userMessages,
    ),
    LLMTimeoutError,
  );
});

test("Anthropic enforces the common timeout", async () => {
  const fake = new FakeAnthropicClient(new Promise(() => undefined));
  const adapter = new AnthropicAdapter(
    {
      ...baseConfig,
      defaultOptions: { timeout: 0.001, maxTokens: 8_000 },
    },
    fake,
  );

  await assert.rejects(adapter.invoke(userMessages), LLMTimeoutError);
});

test("Anthropic wraps generic errors with their cause", async () => {
  const cause = new Error("offline");
  await assert.rejects(
    new AnthropicAdapter(baseConfig, new FakeAnthropicClient(cause)).invoke(
      userMessages,
    ),
    (error: unknown) =>
      error instanceof LLMProviderError && error.cause === cause,
  );
});

test("Anthropic streams only non-empty text deltas", async () => {
  const events = asyncItems([
    { type: "message_start" },
    { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
  ]);
  const fake = new FakeAnthropicClient(events);
  const chunks: string[] = [];

  for await (const chunk of new AnthropicAdapter(baseConfig, fake).streamInvoke(
    userMessages,
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, ["a", "b"]);
  assert.equal(fake.lastRequest.stream, true);
  assert.ok(fake.lastRequestOptions.signal instanceof AbortSignal);
});

test("Anthropic aborts the provider stream when the consumer exits early", async () => {
  const fake = new FakeAnthropicClient(
    asyncItems([
      { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
    ]),
  );

  for await (const _chunk of new AnthropicAdapter(baseConfig, fake).streamInvoke(
    userMessages,
  )) {
    break;
  }

  assert.equal(fake.lastRequestOptions.signal.aborted, true);
});

test("Anthropic stream cleanup cannot replace the provider error", async () => {
  const providerError = new Error("provider stream failed");
  const closeError = new Error("stream close failed");
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw providerError;
        },
        async return(): Promise<IteratorResult<unknown>> {
          throw closeError;
        },
      };
    },
  };
  const adapter = new AnthropicAdapter(
    baseConfig,
    new FakeAnthropicClient(stream),
  );

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.streamInvoke(userMessages)) {
        // The fake fails before yielding.
      }
    },
    (error: unknown) =>
      error instanceof LLMProviderError && error.cause === providerError,
  );
});

test("Anthropic stream errors do not wait forever for iterator cleanup", async () => {
  const providerError = new Error("provider stream failed");
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          throw providerError;
        },
        return(): Promise<IteratorResult<unknown>> {
          return new Promise(() => undefined);
        },
      };
    },
  };
  const adapter = new AnthropicAdapter(
    baseConfig,
    new FakeAnthropicClient(stream),
  );
  const operation = (async () => {
    try {
      for await (const _chunk of adapter.streamInvoke(userMessages)) {
        // The fake fails before yielding.
      }
      return "resolved";
    } catch (error) {
      return error;
    }
  })();

  const outcome = await Promise.race([
    operation,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);
  assert.notEqual(outcome, "hung");
  assert.ok(outcome instanceof LLMProviderError);
  assert.equal(outcome.cause, providerError);
});
