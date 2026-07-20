import assert from "node:assert/strict";
import test from "node:test";

import {
  createGeminiAdapter,
  GeminiAdapter,
} from "../../src/llm-client/adapters/gemini.js";
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

class FakeGeminiClient {
  lastRequest: any;

  constructor(
    private readonly response: unknown,
    private readonly streamResponse: unknown = response,
  ) {}

  readonly models = {
    generateContent: async (request: any): Promise<unknown> => {
      this.lastRequest = request;
      if (this.response instanceof Error) throw this.response;
      return this.response;
    },
    generateContentStream: async (request: any): Promise<unknown> => {
      this.lastRequest = request;
      if (this.streamResponse instanceof Error) throw this.streamResponse;
      return this.streamResponse;
    },
  };
}

const basicResponse = {
  modelVersion: "gemini-test",
  text: "done",
  functionCalls: [],
  usageMetadata: {
    promptTokenCount: 3,
    candidatesTokenCount: 4,
    totalTokenCount: 7,
  },
  candidates: [{ finishReason: "STOP" }],
};

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("Gemini converts schemas, calls, and tool results", async () => {
  const fake = new FakeGeminiClient(basicResponse);
  const response = await new GeminiAdapter(baseConfig, fake).invoke(
    commonHistory,
    [bashSchema],
  );

  assert.deepEqual(fake.lastRequest.config.tools, [{
    functionDeclarations: [{
      name: "bash",
      description: "Run a shell command.",
      parametersJsonSchema: bashSchema.function.parameters,
    }],
  }]);
  assert.equal(fake.lastRequest.config.systemInstruction, "system one\n\nsystem two");
  assert.equal(fake.lastRequest.contents[1].role, "model");
  assert.equal(fake.lastRequest.contents[2].parts[0].functionResponse.name, "bash");
  assert.deepEqual(response.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
});

test("Gemini normalizes calls, fallback IDs, and options", async () => {
  const fake = new FakeGeminiClient({
    modelVersion: "gemini-test",
    text: "",
    functionCalls: [{ name: "bash", args: { command: "pwd" } }],
    candidates: [{ finishReason: "MAX_TOKENS" }],
  });
  const response = await new GeminiAdapter(baseConfig, fake).invoke(
    userMessages,
    undefined,
    { maxTokens: 17, temperature: 0.2, topP: 0.8, stop: ["END"] },
  );

  assert.equal(fake.lastRequest.config.maxOutputTokens, 17);
  assert.equal(fake.lastRequest.config.temperature, 0.2);
  assert.equal(fake.lastRequest.config.topP, 0.8);
  assert.deepEqual(fake.lastRequest.config.stopSequences, ["END"]);
  assert.deepEqual(response.toolCalls, [{
    id: "gemini-call-0",
    name: "bash",
    arguments: { command: "pwd" },
  }]);
  assert.equal(response.finishReason, "tool_calls");
});

test("Gemini rejects non-object provider tool arguments", async () => {
  const fake = new FakeGeminiClient({
    ...basicResponse,
    functionCalls: [{ id: "c1", name: "bash", args: [] }],
  });
  await assert.rejects(
    new GeminiAdapter(baseConfig, fake).invoke(userMessages),
    LLMProviderError,
  );
});

test("Gemini configures a custom base URL", async () => {
  let received: unknown;
  const adapter = await createGeminiAdapter(
    { ...baseConfig, baseUrl: "https://gemini.example.test" },
    (options) => {
      received = options;
      return new FakeGeminiClient(basicResponse);
    },
  );
  assert.ok(adapter instanceof GeminiAdapter);
  assert.deepEqual(received, {
    apiKey: "test-key",
    httpOptions: { baseUrl: "https://gemini.example.test" },
  });
});

test("Gemini maps authentication failures", async () => {
  for (const status of [401, 403]) {
    const error = Object.assign(new Error("denied"), { status });
    await assert.rejects(
      new GeminiAdapter(baseConfig, new FakeGeminiClient(error)).invoke(userMessages),
      (caught: unknown) =>
        caught instanceof LLMProviderError && /authentication/.test(caught.message),
    );
  }
});

test("Gemini enforces the common timeout", async () => {
  const adapter = new GeminiAdapter(
    { ...baseConfig, defaultOptions: { timeout: 0.001, maxTokens: 8_000 } },
    new FakeGeminiClient(new Promise(() => undefined)),
  );
  await assert.rejects(adapter.invoke(userMessages), LLMTimeoutError);
});

test("Gemini wraps generic failures with their cause", async () => {
  const cause = new Error("offline");
  await assert.rejects(
    new GeminiAdapter(baseConfig, new FakeGeminiClient(cause)).invoke(userMessages),
    (error: unknown) => error instanceof LLMProviderError && error.cause === cause,
  );
});

test("Gemini streams text and returns complete tool calls", async () => {
  const fake = new FakeGeminiClient(
    basicResponse,
    asyncItems([
      { modelVersion: "gemini-test", text: "working " },
      {
        text: "now",
        functionCalls: [{ name: "bash", args: { command: "pwd" } }],
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 3,
          totalTokenCount: 5,
        },
        candidates: [{ finishReason: "STOP" }],
      },
    ]),
  );

  const events = await collect(
    new GeminiAdapter(baseConfig, fake).stream(userMessages, [bashSchema]),
  );

  assert.deepEqual(events.slice(0, 2), [
    { type: "text_delta", text: "working " },
    { type: "text_delta", text: "now" },
  ]);
  const done = events[2];
  assert.equal(done?.type, "response_done");
  if (done?.type !== "response_done") return;
  assert.equal(done.response.content, "working now");
  assert.deepEqual(done.response.toolCalls, [{
    id: "gemini-call-0",
    name: "bash",
    arguments: { command: "pwd" },
  }]);
  assert.deepEqual(done.response.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
  assert.equal(done.response.finishReason, "tool_calls");
  assert.deepEqual(fake.lastRequest.config.tools[0].functionDeclarations[0], {
    name: "bash",
    description: "Run a shell command.",
    parametersJsonSchema: bashSchema.function.parameters,
  });
});
