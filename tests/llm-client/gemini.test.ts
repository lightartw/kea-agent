import assert from "node:assert/strict";
import test from "node:test";

import {
  createGeminiAdapter,
  GeminiAdapter,
} from "../../src/llm-client/adapters/gemini.js";
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

test("Gemini converts tool calls and tool results", async () => {
  const fake = new FakeGeminiClient(basicResponse);
  const adapter = new GeminiAdapter(baseConfig, fake);

  const response = await adapter.invokeWithTools(commonHistory, [bashSchema]);

  assert.deepEqual(fake.lastRequest.config.tools, [
    {
      functionDeclarations: [
        {
          name: "bash",
          description: "Run a shell command.",
          parametersJsonSchema: bashSchema.function.parameters,
        },
      ],
    },
  ]);
  assert.equal(fake.lastRequest.config.systemInstruction, "system one\n\nsystem two");
  assert.equal(fake.lastRequest.contents[1].role, "model");
  assert.equal(
    fake.lastRequest.contents[2].parts[0].functionResponse.name,
    "bash",
  );
  assert.deepEqual(response.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
  });
  assert.equal(response.finishReason, "stop");
});

test("Gemini normalizes calls, fallback IDs, and options", async () => {
  const fake = new FakeGeminiClient({
    modelVersion: "gemini-test",
    text: "",
    functionCalls: [{ name: "bash", args: { command: "pwd" } }],
    candidates: [{ finishReason: "MAX_TOKENS" }],
  });
  const adapter = new GeminiAdapter(baseConfig, fake);

  const response = await adapter.invoke(userMessages, {
    maxTokens: 17,
    temperature: 0.2,
    topP: 0.8,
    stop: ["END"],
  });

  assert.equal(fake.lastRequest.config.maxOutputTokens, 17);
  assert.equal(fake.lastRequest.config.temperature, 0.2);
  assert.equal(fake.lastRequest.config.topP, 0.8);
  assert.deepEqual(fake.lastRequest.config.stopSequences, ["END"]);
  assert.deepEqual(response.toolCalls, [
    {
      id: "gemini-call-0",
      name: "bash",
      arguments: { command: "pwd" },
    },
  ]);
  assert.equal(response.finishReason, "tool_calls");
});

test("Gemini maps max-token finish reasons without calls", async () => {
  const fake = new FakeGeminiClient({
    ...basicResponse,
    candidates: [{ finishReason: "MAX_TOKENS" }],
  });
  const response = await new GeminiAdapter(baseConfig, fake).invoke(userMessages);
  assert.equal(response.finishReason, "length");
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

test("Gemini preserves caller abort reasons", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  const fake = new FakeGeminiClient(new Promise(() => undefined));
  await assert.rejects(
    new GeminiAdapter(baseConfig, fake).invoke(userMessages, {
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
});

test("Gemini detects 401 and 403 authentication errors", async () => {
  for (const status of [401, 403]) {
    const error = Object.assign(new Error("denied"), { status });
    await assert.rejects(
      new GeminiAdapter(baseConfig, new FakeGeminiClient(error)).invoke(
        userMessages,
      ),
      LLMAuthenticationError,
    );
  }
});

test("Gemini enforces the common timeout", async () => {
  const adapter = new GeminiAdapter(
    {
      ...baseConfig,
      defaultOptions: { timeout: 0.001, maxTokens: 8_000 },
    },
    new FakeGeminiClient(new Promise(() => undefined)),
  );
  await assert.rejects(adapter.invoke(userMessages), LLMTimeoutError);
});

test("Gemini wraps generic errors with their cause", async () => {
  const cause = new Error("offline");
  await assert.rejects(
    new GeminiAdapter(baseConfig, new FakeGeminiClient(cause)).invoke(
      userMessages,
    ),
    (error: unknown) =>
      error instanceof LLMProviderError && error.cause === cause,
  );
});

test("Gemini streams non-empty text and aborts on early exit", async () => {
  const fake = new FakeGeminiClient(
    basicResponse,
    asyncItems([{ text: "a" }, { text: "" }, { functionCalls: [] }, { text: "b" }]),
  );
  const chunks: string[] = [];

  for await (const chunk of new GeminiAdapter(baseConfig, fake).streamInvoke(
    userMessages,
  )) {
    chunks.push(chunk);
    if (chunks.length === 1) break;
  }

  assert.deepEqual(chunks, ["a"]);
  assert.equal(fake.lastRequest.config.abortSignal.aborted, true);
});
