import assert from "node:assert/strict";
import test from "node:test";

import {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "openai";

import { OpenAIAdapter } from "../../src/llm-client/adapters/openai.js";
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

test("OpenAI serializes common assistant tool arguments", async () => {
  const fake = new FakeOpenAIClient(basicResponse);
  const adapter = new OpenAIAdapter(baseConfig, fake);

  const response = await adapter.invokeWithTools(commonHistory, [bashSchema]);

  const assistant = fake.lastRequest.messages.find(
    (message: any) => message.role === "assistant",
  );
  assert.equal(
    assistant.tool_calls[0].function.arguments,
    '{"command":"pwd"}',
  );
  assert.deepEqual(fake.lastRequest.tools, [bashSchema]);
  assert.deepEqual(response.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
  assert.equal(response.finishReason, "stop");
});

test("OpenAI parses tool calls and maps options", async () => {
  const fake = new FakeOpenAIClient({
    model: "gpt-test",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "c1",
              function: { name: "bash", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        finish_reason: "function_call",
      },
    ],
  });
  const adapter = new OpenAIAdapter(baseConfig, fake);

  const response = await adapter.invoke(userMessages, {
    maxTokens: 17,
    temperature: 0.2,
    topP: 0.8,
    stop: ["END"],
  });

  assert.equal(fake.lastRequest.max_tokens, 17);
  assert.equal(fake.lastRequest.temperature, 0.2);
  assert.equal(fake.lastRequest.top_p, 0.8);
  assert.deepEqual(fake.lastRequest.stop, ["END"]);
  assert.deepEqual(response.toolCalls, [
    { id: "c1", name: "bash", arguments: { command: "pwd" } },
  ]);
  assert.deepEqual(response.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.equal(response.finishReason, "tool_calls");
});

test("OpenAI maps length finish reasons", async () => {
  const fake = new FakeOpenAIClient({
    ...basicResponse,
    choices: [
      { message: { content: "partial", tool_calls: [] }, finish_reason: "length" },
    ],
  });
  const response = await new OpenAIAdapter(baseConfig, fake).invoke(userMessages);
  assert.equal(response.finishReason, "length");
});

test("OpenAI rejects non-object provider tool arguments", async () => {
  const fake = new FakeOpenAIClient({
    ...basicResponse,
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "c1", function: { name: "bash", arguments: "[]" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  await assert.rejects(
    new OpenAIAdapter(baseConfig, fake).invoke(userMessages),
    LLMProviderError,
  );
});

test("OpenAI preserves caller abort reasons", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  const fake = new FakeOpenAIClient(new Promise(() => undefined));

  await assert.rejects(
    new OpenAIAdapter(baseConfig, fake).invoke(userMessages, {
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
});

test("OpenAI translates authentication and timeout errors", async () => {
  const authentication = Object.create(AuthenticationError.prototype) as Error;
  const timeout = Object.create(APIConnectionTimeoutError.prototype) as Error;

  await assert.rejects(
    new OpenAIAdapter(baseConfig, new FakeOpenAIClient(authentication)).invoke(
      userMessages,
    ),
    LLMAuthenticationError,
  );
  await assert.rejects(
    new OpenAIAdapter(baseConfig, new FakeOpenAIClient(timeout)).invoke(
      userMessages,
    ),
    LLMTimeoutError,
  );
});

test("OpenAI enforces the common timeout", async () => {
  const adapter = new OpenAIAdapter(
    {
      ...baseConfig,
      defaultOptions: { timeout: 0.001, maxTokens: 8_000 },
    },
    new FakeOpenAIClient(new Promise(() => undefined)),
  );
  await assert.rejects(adapter.invoke(userMessages), LLMTimeoutError);
});

test("OpenAI wraps generic errors with their cause", async () => {
  const cause = new Error("offline");
  await assert.rejects(
    new OpenAIAdapter(baseConfig, new FakeOpenAIClient(cause)).invoke(
      userMessages,
    ),
    (error: unknown) =>
      error instanceof LLMProviderError && error.cause === cause,
  );
});

test("OpenAI streams text deltas and aborts on early exit", async () => {
  const fake = new FakeOpenAIClient(
    asyncItems([
      { choices: [{ delta: { content: "a" } }] },
      { choices: [{ delta: { content: "" } }] },
      { choices: [{ delta: { tool_calls: [] } }] },
      { choices: [{ delta: { content: "b" } }] },
    ]),
  );
  const chunks: string[] = [];

  for await (const chunk of new OpenAIAdapter(baseConfig, fake).streamInvoke(
    userMessages,
  )) {
    chunks.push(chunk);
    if (chunks.length === 1) break;
  }

  assert.deepEqual(chunks, ["a"]);
  assert.equal(fake.lastRequest.stream, true);
  assert.equal(fake.lastRequestOptions.signal.aborted, true);
});
