import assert from "node:assert/strict";
import test from "node:test";

import {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "openai";

import { OpenAIAdapter } from "../../src/llm-client/adapters/openai.js";
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

class FakeOpenAIClient {
  lastRequest: any;
  lastRequestOptions: any;

  constructor(private readonly response: unknown) {}

  readonly chat = {
    completions: {
      create: async (request: any, requestOptions: any): Promise<unknown> => {
        this.lastRequest = request;
        this.lastRequestOptions = requestOptions;
        if (this.response instanceof Error) throw this.response;
        return this.response;
      },
    },
  };
}

const basicResponse = {
  model: "gpt-test",
  choices: [
    { message: { content: "done", tool_calls: [] }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
};

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("OpenAI passes schemas through and serializes history", async () => {
  const fake = new FakeOpenAIClient(basicResponse);
  const response = await new OpenAIAdapter(baseConfig, fake).invoke(
    commonHistory,
    [bashSchema],
  );

  const assistant = fake.lastRequest.messages.find(
    (message: any) => message.role === "assistant",
  );
  assert.equal(assistant.tool_calls[0].function.arguments, '{"command":"pwd"}');
  assert.deepEqual(fake.lastRequest.tools, [bashSchema]);
  assert.deepEqual(response.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
});

test("OpenAI parses tool calls and maps options", async () => {
  const fake = new FakeOpenAIClient({
    model: "gpt-test",
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "c1",
          function: { name: "bash", arguments: '{"command":"pwd"}' },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });

  const response = await new OpenAIAdapter(baseConfig, fake).invoke(
    userMessages,
    undefined,
    { maxTokens: 17, temperature: 0.2, topP: 0.8, stop: ["END"] },
  );

  assert.equal(fake.lastRequest.max_tokens, 17);
  assert.equal(fake.lastRequest.temperature, 0.2);
  assert.equal(fake.lastRequest.top_p, 0.8);
  assert.deepEqual(fake.lastRequest.stop, ["END"]);
  assert.deepEqual(response.toolCalls, [
    { id: "c1", name: "bash", arguments: { command: "pwd" } },
  ]);
  assert.equal(response.finishReason, "tool_calls");
});

test("OpenAI rejects non-object provider tool arguments", async () => {
  const fake = new FakeOpenAIClient({
    ...basicResponse,
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "c1", function: { name: "bash", arguments: "[]" } }],
      },
      finish_reason: "tool_calls",
    }],
  });

  await assert.rejects(
    new OpenAIAdapter(baseConfig, fake).invoke(userMessages),
    LLMProviderError,
  );
});

test("OpenAI maps authentication and timeout failures", async () => {
  const authentication = Object.create(AuthenticationError.prototype) as Error;
  const timeout = Object.create(APIConnectionTimeoutError.prototype) as Error;

  await assert.rejects(
    new OpenAIAdapter(baseConfig, new FakeOpenAIClient(authentication)).invoke(userMessages),
    (error: unknown) =>
      error instanceof LLMProviderError && /authentication/.test(error.message),
  );
  await assert.rejects(
    new OpenAIAdapter(baseConfig, new FakeOpenAIClient(timeout)).invoke(userMessages),
    LLMTimeoutError,
  );
});

test("OpenAI enforces the common timeout", async () => {
  const adapter = new OpenAIAdapter(
    { ...baseConfig, options: { timeout: 0.001, maxTokens: 8_000 } },
    new FakeOpenAIClient(new Promise(() => undefined)),
  );
  await assert.rejects(adapter.invoke(userMessages), LLMTimeoutError);
});

test("OpenAI enforces timeout for the full stream", async () => {
  const fake = {
    chat: {
      completions: {
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
    },
  };
  const adapter = new OpenAIAdapter(
    { ...baseConfig, options: { timeout: 0.001, maxTokens: 8_000 } },
    fake,
  );

  await assert.rejects(collect(adapter.stream(userMessages)), LLMTimeoutError);
});

test("OpenAI wraps generic failures with their cause", async () => {
  const cause = new Error("offline");
  await assert.rejects(
    new OpenAIAdapter(baseConfig, new FakeOpenAIClient(cause)).invoke(userMessages),
    (error: unknown) => error instanceof LLMProviderError && error.cause === cause,
  );
});

test("OpenAI streams text and completes fragmented tool calls", async () => {
  const fake = new FakeOpenAIClient(asyncItems([
    {
      model: "gpt-test",
      choices: [{ delta: { content: "hi " } }],
    },
    {
      choices: [{
        delta: {
          content: "there",
          tool_calls: [{
            index: 0,
            id: "c1",
            function: { name: "bash", arguments: '{"command":' },
          }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ]));

  const events = await collect(
    new OpenAIAdapter(baseConfig, fake).stream(userMessages, [bashSchema]),
  );

  assert.deepEqual(events.slice(0, 2), [
    { type: "text_delta", text: "hi " },
    { type: "text_delta", text: "there" },
  ]);
  const done = events[2];
  assert.equal(done?.type, "response_done");
  if (done?.type !== "response_done") return;
  assert.equal(done.response.content, "hi there");
  assert.deepEqual(done.response.toolCalls, [
    { id: "c1", name: "bash", arguments: { command: "pwd" } },
  ]);
  assert.deepEqual(done.response.usage, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  });
  assert.equal(done.response.finishReason, "tool_calls");
  assert.deepEqual(fake.lastRequest.tools, [bashSchema]);
  assert.deepEqual(fake.lastRequest.stream_options, { include_usage: true });
});

test("OpenAI normalizes malformed streamed tool arguments", async () => {
  const fake = new FakeOpenAIClient(asyncItems([{
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "c1",
          function: { name: "bash", arguments: "{" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }]));

  await assert.rejects(
    collect(new OpenAIAdapter(baseConfig, fake).stream(userMessages, [bashSchema])),
    LLMProviderError,
  );
});
