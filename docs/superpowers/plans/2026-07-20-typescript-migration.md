# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python Kea Agent with a behaviorally equivalent strict-TypeScript implementation, verify it with a new TypeScript test suite, remove every Python artifact, and rebuild `master` as one TypeScript root commit.

**Architecture:** Translate in dependency order while Python remains available as a reference. Keep the side-effect-free LLM contract, provider adapters, ToolRegistry, BashTool, and Agent loop isolated behind explicit interfaces; load only the selected provider SDK through a memoized lazy client. Remove Python and destroy old Git history only after clean-install acceptance succeeds.

**Tech Stack:** Node.js 24 LTS, npm 11, ESM, TypeScript 7 strict mode, `node:test`, TypeBox, `@anthropic-ai/sdk`, `openai`, `@google/genai`, and `dotenv`.

## Global Constraints

- Work directly on `master`; do not create a worktree.
- This is a behavior-equivalent language migration. Do not add a TUI, MCP, retries, model catalogs, OAuth, multimodal content, reasoning events, parallel tools, or streaming tool calls.
- Keep `invoke()`, non-streaming `invokeWithTools()`, and text-only `streamInvoke(): AsyncIterable<string>` as the public LLM operations.
- Keep automatic detection limited to exactly one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`.
- Preserve explicit `provider`, `model`, `apiKey`, and `baseUrl`; preserve `maxTokens`, `timeout`, `temperature`, `topP`, and `stop` option precedence.
- Keep public TypeScript names in `camelCase`; keep provider payload keys in their native form.
- Keep OpenAI function-tool JSON as the neutral provider boundary.
- Use TypeBox schemas without conversion, cleaning, default insertion, or mutation.
- Execute tool calls sequentially in provider response order.
- Keep the four recorded defects out of scope and do not claim they are fixed.
- Never read, print, overwrite, or commit `.env`.
- Use only mocked SDK clients in tests; no test may issue a live provider request.
- Commit after every task. Intermediate commits will be replaced by the final root commit only after acceptance.

## File Map

### New production files

- `src/index.ts`: side-effect-free public exports.
- `src/agent-loop.ts`: provider-neutral Agent orchestration.
- `src/main.ts`: dotenv loading, readline CLI, and process entry point.
- `src/utils/abort-signals.ts`: combine caller and timeout signals with listener cleanup.
- `src/llm-client/models.ts`: common messages, tools, usage, calls, and responses.
- `src/llm-client/errors.ts`: public LLM error hierarchy.
- `src/llm-client/client.ts`: client interfaces, option merge, and public input validation.
- `src/llm-client/factory.ts`: deterministic provider resolution and memoized lazy loading.
- `src/llm-client/index.ts`: LLM public exports.
- `src/llm-client/adapters/anthropic.ts`: Anthropic request/response translation.
- `src/llm-client/adapters/openai.ts`: OpenAI Chat Completions translation.
- `src/llm-client/adapters/gemini.ts`: Gemini Generate Content translation.
- `src/tools/base.ts`: generic TypeBox Tool and ToolResult.
- `src/tools/errors.ts`: public tool error hierarchy.
- `src/tools/registry.ts`: registration, validation, timeout, dispatch, and truncation.
- `src/tools/index.ts`: tool public exports.
- `src/tools/builtin/bash.ts`: asynchronous shell tool.

### New test files

- `tests/utils/abort-signals.test.ts`
- `tests/llm-client/client.test.ts`
- `tests/llm-client/fixtures.ts`
- `tests/llm-client/anthropic.test.ts`
- `tests/llm-client/openai.test.ts`
- `tests/llm-client/gemini.test.ts`
- `tests/llm-client/factory.test.ts`
- `tests/tools/base.test.ts`
- `tests/tools/registry.test.ts`
- `tests/tools/bash.test.ts`
- `tests/agent-loop.test.ts`
- `tests/import-smoke.test.ts`

### Project and documentation files

- Create `package.json`, `package-lock.json`, and `tsconfig.json`.
- Modify `.gitignore`, `.env.example`, and `README.md`.
- Delete `main.py`, `llm_client/`, `tools/`, `pyproject.toml`, `uv.lock`, `requirements.txt`, `.venv/`, Python caches, and superseded Python plans/specifications only in Task 10.

---

### Task 1: Node foundation, strict compilation, and abort-signal utility

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `src/utils/abort-signals.ts`
- Create: `tests/utils/abort-signals.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `combineAbortSignals(signals): { signal?: AbortSignal; cleanup(): void }`.
- Produces: the `npm run typecheck`, `npm run build`, `npm test`, and `npm start` commands used by every later task.

- [ ] **Step 1: Add the Node/npm project configuration**

Create `package.json` with exact dependency versions verified on 2026-07-20:

```json
{
  "name": "kea-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
    "typecheck": "tsc --noEmit",
    "build": "npm run clean && tsc",
    "test": "npm run build && node --test dist/tests",
    "start": "node dist/src/main.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "0.112.3",
    "@google/genai": "2.12.0",
    "dotenv": "17.4.2",
    "openai": "6.48.0",
    "typebox": "1.3.6"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "typescript": "7.0.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Append `node_modules/`, `dist/`, and `coverage/` to `.gitignore` without removing Python ignores yet. Run `npm install` to install the declared dependencies and generate `package-lock.json` without reading or modifying `.env`.

- [ ] **Step 2: Write the failing abort-signal tests**

Create `tests/utils/abort-signals.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { combineAbortSignals } from "../../src/utils/abort-signals.js";

test("combineAbortSignals preserves the first abort reason", () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);
  first.abort("caller cancelled");
  second.abort("timeout");
  assert.equal(combined.signal?.aborted, true);
  assert.equal(combined.signal?.reason, "caller cancelled");
  combined.cleanup();
});

test("cleanup detaches listeners from combined signals", () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);
  combined.cleanup();
  first.abort("late abort");
  assert.equal(combined.signal?.aborted, false);
});
```

- [ ] **Step 3: Run the tests and confirm the missing-module failure**

Run: `npm test`

Expected: compilation fails because `src/utils/abort-signals.ts` does not exist.

- [ ] **Step 4: Implement signal combination and the side-effect-free entry point**

Implement `src/utils/abort-signals.ts` with the same first-reason and cleanup semantics asserted above. Zero signals return `{ cleanup() {} }`; one signal returns it unchanged; two or more signals use one `AbortController` and `{ once: true }` listeners. Create `src/index.ts` with only exports and no executable statements:

```ts
export { combineAbortSignals } from "./utils/abort-signals.js";
export type { CombinedAbortSignal } from "./utils/abort-signals.js";
```

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: 2 tests pass, type-check succeeds, and no whitespace errors are reported.

```powershell
git add package.json package-lock.json tsconfig.json .gitignore src/index.ts src/utils/abort-signals.ts tests/utils/abort-signals.test.ts
git commit -m "build: add TypeScript project foundation"
```

---

### Task 2: Common LLM types, validation, options, and errors

**Files:**
- Create: `src/llm-client/models.ts`
- Create: `src/llm-client/errors.ts`
- Create: `src/llm-client/client.ts`
- Create: `src/llm-client/index.ts`
- Create: `tests/llm-client/client.test.ts`
- Create: `tests/llm-client/fixtures.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `Message`, `ToolSchema`, `ToolCall`, `LLMResponse`, `LLMOptions`, `LLMCallOptions`, `ResolvedLLMOptions`, and `AdapterConfig`.
- Produces: `LLMClient`, `mergeOptions()`, `validateMessages()`, and `validateTools()`.
- Produces: `LLMError`, `LLMConfigurationError`, `LLMTimeoutError`, `LLMAuthenticationError`, and `LLMProviderError`.

- [ ] **Step 1: Write contract and validation tests**

Create tests that assert these exact behaviors:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mergeOptions, validateMessages, validateTools } from "../../src/llm-client/client.js";
import { LLMConfigurationError } from "../../src/llm-client/errors.js";

test("call options override defaults", () => {
  const controller = new AbortController();
  const options = mergeOptions({ maxTokens: 4096, timeout: 60 }, { maxTokens: 7, signal: controller.signal });
  assert.equal(options.maxTokens, 7);
  assert.equal(options.timeout, 60);
  assert.equal(options.signal, controller.signal);
});

test("unknown runtime options are rejected", () => {
  assert.throws(
    () => mergeOptions({}, { providerPrivate: true } as never),
    LLMConfigurationError,
  );
});

test("assistant tool arguments must be objects", () => {
  assert.throws(
    () => validateMessages([{ role: "assistant", content: null, toolCalls: [{ id: "1", name: "bash", arguments: [] as never }] }]),
    /arguments must be an object/,
  );
});

test("function tools require an object parameter schema", () => {
  assert.throws(
    () => validateTools([{ type: "function", function: { name: "bad", description: "bad", parameters: { type: "string" } as never } }]),
    /parameters.type must be object/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build`

Expected: TypeScript reports missing `src/llm-client/client.ts` and related modules.

- [ ] **Step 3: Implement the common contract**

Use discriminated message interfaces with these exact property names:

```ts
export type ProviderName = "anthropic" | "openai" | "gemini";
export type FinishReason = "stop" | "length" | "tool_calls" | null;
export type ToolArguments = Record<string, unknown>;

export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: ToolArguments; }
export interface SystemMessage { readonly role: "system"; readonly content: string; }
export interface UserMessage { readonly role: "user"; readonly content: string; }
export interface AssistantMessage { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: readonly ToolCall[]; }
export interface ToolResultMessage { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly content: string; }
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  readonly latencyMs: number;
  readonly finishReason: FinishReason;
}
```

Define `LLMOptions` with `timeout`, `maxTokens`, `temperature`, `topP`, and `stop`; define `LLMCallOptions` by adding `signal`; define defaults of 120 seconds and 8000 tokens. `mergeOptions()` must reject unknown runtime keys, validate positive timeout and integer `maxTokens`, preserve optional values, and never store `signal` in client defaults. `validateMessages()` and `validateTools()` must reproduce the current common boundary checks without coercion. Define `LLMClient` with the three methods approved in the design.

Define this adapter construction boundary in `client.ts`:

```ts
export interface AdapterConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly defaultOptions: ResolvedLLMOptions;
}
```

- [ ] **Step 4: Add shared local test fixtures**

Create `tests/llm-client/fixtures.ts`:

```ts
import type { AdapterConfig, LLMClient } from "../../src/llm-client/client.js";
import type { LLMResponse, Message, ToolSchema } from "../../src/llm-client/models.js";

export const baseConfig: AdapterConfig = {
  model: "test-model",
  apiKey: "test-key",
  baseUrl: null,
  defaultOptions: { timeout: 120, maxTokens: 8000 },
};

export const userMessages: Message[] = [{ role: "user", content: "hello" }];

export const commonHistory: Message[] = [
  { role: "system", content: "system one" },
  { role: "system", content: "system two" },
  { role: "user", content: "run pwd" },
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "call-1", name: "bash", arguments: { command: "pwd" } }],
  },
  { role: "tool", toolCallId: "call-1", name: "bash", content: "/tmp" },
];

export const bashSchema: ToolSchema = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export const textResponse: LLMResponse = {
  model: "test-model",
  content: "ok",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  latencyMs: 0,
  finishReason: "stop",
};

export const fakeClient: LLMClient = {
  async invoke() { return textResponse; },
  async invokeWithTools() { return textResponse; },
  async *streamInvoke() { yield "ok"; },
};

export async function* asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
```

- [ ] **Step 5: Implement errors and exports**

Every subclass sets a stable `name` and accepts standard `ErrorOptions`:

```ts
export class LLMError extends Error { override name = "LLMError"; }
export class LLMConfigurationError extends LLMError { override name = "LLMConfigurationError"; }
export class LLMTimeoutError extends LLMError { override name = "LLMTimeoutError"; }
export class LLMAuthenticationError extends LLMError { override name = "LLMAuthenticationError"; }
export class LLMProviderError extends LLMError { override name = "LLMProviderError"; }
```

Export the public surface from `src/llm-client/index.ts` and re-export it from `src/index.ts`.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: all contract tests and Task 1 tests pass.

```powershell
git add src/index.ts src/llm-client tests/llm-client/client.test.ts tests/llm-client/fixtures.ts
git commit -m "feat: add TypeScript LLM contract"
```

---

### Task 3: Anthropic adapter

**Files:**
- Create: `src/llm-client/adapters/anthropic.ts`
- Create: `tests/llm-client/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 2 `LLMClient`, common messages, schemas, options, responses, and errors.
- Produces: `AnthropicAdapter` and `createAnthropicAdapter(config)`.

- [ ] **Step 1: Write fake-client tests before importing the production SDK path**

Build this structural fake so no real Anthropic client is constructed:

```ts
class FakeAnthropicClient {
  lastRequest: any;
  lastRequestOptions: any;
  constructor(private readonly response: unknown) {}
  readonly messages = {
    create: async (request: any, requestOptions: any) => {
      this.lastRequest = request;
      this.lastRequestOptions = requestOptions;
      return this.response;
    },
  };
}
```

Cover:

```ts
test("Anthropic converts system, tool calls, and tool results", async () => {
  const fake = new FakeAnthropicClient({
    model: "claude-test",
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4 },
    content: [{ type: "text", text: "done" }],
  });
  const adapter = new AnthropicAdapter(baseConfig, fake);
  const response = await adapter.invokeWithTools(commonHistory, [bashSchema]);
  assert.equal(fake.lastRequest.system, "system one\n\nsystem two");
  assert.deepEqual(fake.lastRequest.tools[0].input_schema, bashSchema.function.parameters);
  assert.deepEqual(response, {
    model: "claude-test",
    content: "done",
    toolCalls: [],
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    latencyMs: response.latencyMs,
    finishReason: "stop",
  });
});
```

Add cases for `tool_use` normalization, stop/max-token/tool-use finish reasons, option mapping, authentication errors, generic errors with `cause`, timeout, caller abort propagation, and text-only streaming deltas.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build`

Expected: missing Anthropic adapter exports.

- [ ] **Step 3: Implement Anthropic conversion and normalization**

Implement these pure helpers inside the module:

```ts
function convertMessages(messages: readonly Message[]): { system?: string; messages: AnthropicMessageParam[] };
function convertTools(tools: readonly ToolSchema[]): AnthropicToolParam[];
function requestOptions(options: ResolvedLLMOptions): Record<string, unknown>;
function finishReason(reason: string | null | undefined): FinishReason;
function normalize(response: AnthropicResponse, latencyMs: number): LLMResponse;
```

Preserve current behavior: join system messages with blank lines, batch consecutive tool results into one Anthropic user message, include assistant text before `tool_use` blocks, map `parameters` to `input_schema`, map `stop` to `stop_sequences`, concatenate text blocks, and normalize token totals. `invoke()` and `invokeWithTools()` call `messages.create`; `streamInvoke()` calls the SDK with `stream: true` and yields only `content_block_delta` events whose delta type is `text_delta` and text is non-empty.

Pass the combined abort signal through the SDK request options. Translate SDK authentication and timeout classes; if the caller signal is aborted, throw its original reason; otherwise wrap failures with `cause`.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: Anthropic request, response, stream, and error tests pass without network access.

```powershell
git add src/llm-client/adapters/anthropic.ts tests/llm-client/anthropic.test.ts
git commit -m "feat: add Anthropic TypeScript adapter"
```

---

### Task 4: OpenAI adapter

**Files:**
- Create: `src/llm-client/adapters/openai.ts`
- Create: `tests/llm-client/openai.test.ts`

**Interfaces:**
- Consumes: Task 2 common LLM contract.
- Produces: `OpenAIAdapter` and `createOpenAIAdapter(config)` using Chat Completions.

- [ ] **Step 1: Write OpenAI adapter tests with a fake Chat Completions client**

Use this structural fake and assert exact request translation and normalized output:

```ts
class FakeOpenAIClient {
  lastRequest: any;
  lastRequestOptions: any;
  constructor(private readonly response: unknown) {}
  readonly chat = {
    completions: {
      create: async (request: any, requestOptions: any) => {
        this.lastRequest = request;
        this.lastRequestOptions = requestOptions;
        return this.response;
      },
    },
  };
}
```

```ts
test("OpenAI serializes common assistant tool arguments", async () => {
  const fake = new FakeOpenAIClient({
    model: "gpt-test",
    choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  const adapter = new OpenAIAdapter(baseConfig, fake);
  await adapter.invokeWithTools(commonHistory, [bashSchema]);
  const assistant = fake.lastRequest.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.tool_calls[0].function.arguments, '{"command":"pwd"}');
  assert.deepEqual(fake.lastRequest.tools, [bashSchema]);
});
```

Add cases for parsed tool calls, missing usage, finish-reason mapping, option overrides, authentication, timeout, provider errors with `cause`, abort propagation, and streamed `choices[].delta.content`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build`

Expected: missing OpenAI adapter exports.

- [ ] **Step 3: Implement Chat Completions translation**

Use the official `openai` client but accept a structural fake in the constructor. Preserve the common history conversion: assistant tool calls become OpenAI function calls with JSON-string arguments; tool results include `tool_call_id`; all other messages retain role and content. Pass the common tool schema directly. Map `maxTokens` to `max_tokens` and sampling options to their existing names.

Normalize `choices[0]`, parse each function argument with `JSON.parse(arguments || "{}")`, normalize token usage, and map `stop`, `length`, `tool_calls`, and `function_call`. For streaming, request `stream: true`, iterate the returned stream, and yield each non-empty text delta. Use the shared abort/timeout lifecycle and preserve caller aborts.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: all OpenAI and prior tests pass.

```powershell
git add src/llm-client/adapters/openai.ts tests/llm-client/openai.test.ts
git commit -m "feat: add OpenAI TypeScript adapter"
```

---

### Task 5: Gemini adapter

**Files:**
- Create: `src/llm-client/adapters/gemini.ts`
- Create: `tests/llm-client/gemini.test.ts`

**Interfaces:**
- Consumes: Task 2 common LLM contract.
- Produces: `GeminiAdapter` and `createGeminiAdapter(config)` using `GoogleGenAI.models`.

- [ ] **Step 1: Write Gemini request, response, stream, and error tests**

Use this structural fake:

```ts
class FakeGeminiClient {
  lastRequest: any;
  constructor(
    private readonly response: unknown,
    private readonly streamResponse: unknown = response,
  ) {}
  readonly models = {
    generateContent: async (request: any) => {
      this.lastRequest = request;
      return this.response;
    },
    generateContentStream: async (request: any) => {
      this.lastRequest = request;
      return this.streamResponse;
    },
  };
}
```

Include this representative conversion assertion:

```ts
test("Gemini converts tool calls and tool results", async () => {
  const fake = new FakeGeminiClient({
    modelVersion: "gemini-test",
    text: "done",
    functionCalls: [],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    candidates: [{ finishReason: "STOP" }],
  });
  const adapter = new GeminiAdapter(baseConfig, fake);
  await adapter.invokeWithTools(commonHistory, [bashSchema]);
  assert.deepEqual(fake.lastRequest.config.tools, [{
    functionDeclarations: [{
      name: "bash",
      description: "Run a shell command.",
      parametersJsonSchema: bashSchema.function.parameters,
    }],
  }]);
  assert.equal(fake.lastRequest.contents[1].role, "model");
  assert.equal(fake.lastRequest.contents[2].parts[0].functionResponse.name, "bash");
});
```

Add cases for generated fallback call IDs, usage and finish reasons, base URL configuration, 401/403 authentication detection, timeout, generic errors, caller abort, and non-empty stream chunks.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build`

Expected: missing Gemini adapter exports.

- [ ] **Step 3: Implement Gemini translation**

Join system messages into `systemInstruction`; map assistant to `model`; map tool calls to `functionCall`; map tool results to user `functionResponse` parts with `{ output: content }`. Convert common tools to `functionDeclarations` using `parametersJsonSchema`. Map `maxTokens` to `maxOutputTokens`, plus `temperature`, `topP`, and `stopSequences`.

Normalize `response.functionCalls`, `response.text`, `usageMetadata`, model version, and candidate finish reason. A response containing calls always finishes as `tool_calls`. Stream with `generateContentStream()` and yield non-empty `chunk.text`. Configure `httpOptions.baseUrl` only when supplied and pass the combined signal as `config.abortSignal`.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: Gemini and all previous tests pass.

```powershell
git add src/llm-client/adapters/gemini.ts tests/llm-client/gemini.test.ts
git commit -m "feat: add Gemini TypeScript adapter"
```

---

### Task 6: Deterministic factory and memoized lazy client

**Files:**
- Create: `src/llm-client/factory.ts`
- Create: `tests/llm-client/factory.test.ts`
- Modify: `src/llm-client/index.ts`

**Interfaces:**
- Consumes: all three adapter creator functions and Task 2 contracts.
- Produces: synchronous `createLLMClient(options?, environment?, loaders?): LLMClient`.

- [ ] **Step 1: Write provider resolution and lazy-loading tests**

Cover zero/one/multiple markers, explicit provider bypass, missing model/key, explicit/environment precedence, unknown provider, one selected loader, concurrent memoization, and loader failure wrapping. The concurrency test must use injected loaders:

```ts
test("concurrent first calls share one adapter loader", async () => {
  let loads = 0;
  const loaders = {
    anthropic: async () => { loads += 1; return fakeClient; },
    openai: async () => { throw new Error("wrong loader"); },
    gemini: async () => { throw new Error("wrong loader"); },
  };
  const client = createLLMClient(
    { provider: "anthropic", model: "m", apiKey: "k" },
    {},
    loaders,
  );
  await Promise.all([client.invoke(userMessages), client.invoke(userMessages)]);
  assert.equal(loads, 1);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build`

Expected: missing factory exports.

- [ ] **Step 3: Implement deterministic resolution and lazy delegation**

Use only this provider table:

```ts
const PROVIDERS = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  gemini: { apiKey: "GEMINI_API_KEY", baseUrl: "GEMINI_BASE_URL" },
} as const;
```

Default loaders dynamically import only one adapter module. `LazyLLMClient` stores one `clientPromise`; `invoke()` and `invokeWithTools()` await it; `streamInvoke()` is an async generator that awaits it and forwards chunks. Configuration validation remains synchronous. A loader rejection becomes `LLMProviderError` with `cause`. Re-export `createLLMClient`.

- [ ] **Step 4: Verify import side effects, tests, and commit**

Run: `npm test && npm run typecheck && node -e "import('./dist/src/index.js')" && git diff --check`

Expected: all commands exit 0 without credentials or network access.

```powershell
git add src/llm-client/factory.ts src/llm-client/index.ts tests/llm-client/factory.test.ts
git commit -m "feat: add lazy TypeScript LLM factory"
```

---

### Task 7: Generic TypeBox Tool and ToolRegistry

**Files:**
- Create: `src/tools/base.ts`
- Create: `src/tools/errors.ts`
- Create: `src/tools/registry.ts`
- Create: `src/tools/index.ts`
- Create: `tests/tools/base.test.ts`
- Create: `tests/tools/registry.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: TypeBox and `combineAbortSignals()`.
- Produces: `Tool<TParameters>`, `ToolResult`, `ToolRegistry`, and tool errors.
- Produces: `execute(name, arguments, signal?): Promise<ToolResult>`.

- [ ] **Step 1: Write base and Registry tests**

Define fake tools with explicit TypeBox schemas. Cover schema export, immutability, registration order, duplicates, malformed metadata, undeclared required properties, unknown tools, strict arguments, timeout, caller cancellation, thrown errors, non-string returns, truncation, and original argument values.

```ts
const echoParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

class EchoTool extends Tool<typeof echoParameters> {
  constructor() {
    super("echo", "Echo a value.", echoParameters);
  }
  async execute(arguments_: Static<typeof echoParameters>): Promise<string> {
    return arguments_.value;
  }
}

test("Registry validates without coercion", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  const result = await registry.execute("echo", { value: 7 });
  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: Invalid arguments/);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm run build`

Expected: missing tool modules.

- [ ] **Step 3: Implement the generic Tool contract and errors**

`Tool<TParameters extends TSchema>` stores explicit name, description, parameters, and nullable timeout. `execute()` accepts `Static<TParameters>` and an `AbortSignal`. `toSchema()` returns a deep-cloned OpenAI function-tool wrapper. `ToolResult` is `{ readonly content: string; readonly isError: boolean }`, defaulting `isError` to false through a helper or constructor.

Implement `ToolError`, `ToolConfigurationError`, and `ToolExecutionError` with stable names and `cause` support.

- [ ] **Step 4: Implement Registry validation and dispatch**

Use `Compile` from `typebox/compile`; never call TypeBox conversion APIs. Cache each compiled validator at registration. Preserve insertion order with `Map`. Expected execution failures become `ToolResult` beginning with `"Error: "`; caller cancellation escapes. Race execution against the combined caller/timeout signal so a tool that ignores cancellation cannot block the Registry result. Preserve the configured default timeout of 120 seconds and result limit of 50,000 characters.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: all Tool and Registry cases pass.

```powershell
git add src/index.ts src/tools tests/tools/base.test.ts tests/tools/registry.test.ts
git commit -m "feat: add TypeBox tool registry"
```

---

### Task 8: Asynchronous BashTool

**Files:**
- Create: `src/tools/builtin/bash.ts`
- Create: `tests/tools/bash.test.ts`
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: Task 7 `Tool`, TypeBox, and `ToolExecutionError`.
- Produces: `BashTool` with `{ command: string }` input and optional cwd/timeout.

- [ ] **Step 1: Write cross-platform BashTool tests**

Use the Node executable for harmless shell commands:

```ts
test("BashTool captures output", async () => {
  const tool = new BashTool({ cwd: process.cwd() });
  const output = await tool.execute(
    { command: 'node -e "process.stdout.write(\'ok\')"' },
    new AbortController().signal,
  );
  assert.equal(output, "ok");
});
```

Add tests for stdout+stderr order, empty output, non-zero exit detail, dangerous fragments, cwd, non-string defense through an untyped call, and abort of a long-running wrapper. Do not assert process-tree termination.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm run build`

Expected: missing BashTool module.

- [ ] **Step 3: Implement BashTool**

Define parameters with `Type.Object({ command: Type.String({ description: "Shell command to execute." }) }, { additionalProperties: false })`. Use `spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal })`. Accumulate stdout and stderr buffers, concatenate in the same stdout-then-stderr order as Python, decode as UTF-8 with replacement, and trim. Return `"(no output)"` when empty. Reject dangerous fragments before spawning. Translate non-zero close status and spawn errors to `ToolExecutionError`. Allow abort errors to propagate.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && git diff --check`

Expected: all BashTool and previous tests pass on Windows; commands are also POSIX-compatible.

```powershell
git add src/tools/index.ts src/tools/builtin/bash.ts tests/tools/bash.test.ts
git commit -m "feat: add asynchronous TypeScript Bash tool"
```

---

### Task 9: Agent loop, CLI entry, and import smoke test

**Files:**
- Create: `src/agent-loop.ts`
- Create: `src/main.ts`
- Create: `tests/agent-loop.test.ts`
- Create: `tests/import-smoke.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `LLMClient`, `ToolRegistry`, `BashTool`, and optional caller signal.
- Produces: `createToolRegistry(cwd)`, `agentLoop(messages, client, registry, signal?)`, and `asyncMain()`.

- [ ] **Step 1: Write Agent loop tests**

Use a fake client returning two tool calls followed by final text, and fake tools that append their names to an array. The core test is:

```ts
const emptyParameters = Type.Object({}, { additionalProperties: false });
const executionOrder: string[] = [];

class OrderedTool extends Tool<typeof emptyParameters> {
  constructor(name: string) { super(name, `Run ${name}.`, emptyParameters); }
  async execute(): Promise<string> {
    executionOrder.push(this.name);
    return `${this.name} result`;
  }
}

const registry = new ToolRegistry();
registry.register(new OrderedTool("first"));
registry.register(new OrderedTool("second"));

let invocation = 0;
const client: LLMClient = {
  async invoke() { throw new Error("plain invoke is not used by the Agent loop"); },
  async invokeWithTools() {
    invocation += 1;
    if (invocation === 1) {
      return {
        model: "test-model",
        content: null,
        toolCalls: [
          { id: "call-1", name: "first", arguments: {} },
          { id: "call-2", name: "second", arguments: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        latencyMs: 0,
        finishReason: "tool_calls",
      };
    }
    return {
      model: "test-model",
      content: "finished",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 0,
      finishReason: "stop",
    };
  },
  async *streamInvoke() { yield "unused"; },
};

const history: Message[] = [
  { role: "system", content: "system" },
  { role: "user", content: "run tools" },
];

const response = await agentLoop(history, client, registry);
assert.equal(response.content, "finished");
assert.deepEqual(executionOrder, ["first", "second"]);
assert.deepEqual(history.map((message) => message.role), [
  "system", "user", "assistant", "tool", "tool", "assistant",
]);
```

Assert that Registry errors are appended as normal tool-result content, the call ID/name are preserved, the same signal reaches the client and Registry, and no Bash-specific branch exists in `agent-loop.ts`.

- [ ] **Step 2: Write the import smoke test**

Spawn a clean Node child with all provider API key variables removed and import `dist/src/index.js`. Assert exit code 0 and no stdout/stderr. This proves that the public core neither loads `.env` nor constructs provider clients.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npm run build`

Expected: missing Agent loop and main modules.

- [ ] **Step 4: Implement the standalone Agent loop**

Move only orchestration into `src/agent-loop.ts`. It must append a common assistant message, return when `toolCalls` is empty, otherwise call `registry.execute()` for each call in order, append every `ToolResult`, and repeat. Keep the existing yellow command display and 200-character result preview. Accept dependencies and optional signal explicitly; do not read environment variables or initialize readline.

- [ ] **Step 5: Implement the line-oriented CLI**

In `asyncMain()`, call `dotenv.config({ override: true })`, create the client and Registry, register `BashTool(process.cwd())`, and use `node:readline/promises` for the `s01 >>` prompt. Preserve `q`, `exit`, and blank-input exits, colors, system prompt, and `s01: Agent Loop` heading. Guard execution with an ESM main-module check so importing `src/main.ts` does not start the CLI.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run typecheck && npm run build && node -e "import('./dist/src/index.js')" && git diff --check`

Expected: Agent round trip, import smoke test, and full suite pass without API credentials.

```powershell
git add src/index.ts src/agent-loop.ts src/main.ts tests/agent-loop.test.ts tests/import-smoke.test.ts
git commit -m "feat: migrate Agent loop and CLI to TypeScript"
```

---

### Task 10: Documentation migration and Python removal

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `.gitignore`
- Delete: `main.py`
- Delete: `llm_client/`
- Delete: `tools/`
- Delete: `pyproject.toml`
- Delete: `uv.lock`
- Delete: `requirements.txt`
- Delete: six superseded Python design/plan documents listed below
- Delete locally: `.venv/`, `.pytest_cache/`, `__pycache__/`

**Interfaces:**
- Consumes: all completed TypeScript behavior and npm commands.
- Produces: a pure TypeScript working tree with current documentation.

- [ ] **Step 1: Rewrite README commands and examples**

Document Node.js 24 LTS and npm. Linux/macOS primary setup must be:

```bash
npm ci
cp .env.example .env
$EDITOR .env
npm run build
npm start
```

Document PowerShell with `Copy-Item`, `notepad`, `npm ci`, `npm run build`, and `npm start`. Replace Python client examples with `createLLMClient()`, `await client.invoke()`, `for await` streaming, and camelCase response fields. Preserve unique-provider detection, provider variables, Registry behavior, sequential tools, security warning, and text-only streaming documentation. Show concrete dependency-update examples: `npm install --save-exact openai@6.48.0` and `npm install --save-dev --save-exact typescript@7.0.2`.

- [ ] **Step 2: Update environment and ignore documentation**

Keep `.env.example` values and provider rules unchanged; adjust comments only where they mention Python. Replace Python ignore entries with:

```gitignore
# Local secrets
.env

# Node dependencies and build output
node_modules/
dist/
coverage/

# Editors and operating systems
.idea/
.vscode/
.DS_Store
Thumbs.db
```

- [ ] **Step 3: Delete tracked Python implementation and superseded documents with `apply_patch`**

Delete the Python code/tooling plus:

```text
docs/superpowers/specs/2026-07-20-project-initialization-design.md
docs/superpowers/specs/2026-07-20-tool-system-design.md
docs/superpowers/specs/2026-07-20-unified-llm-client-design.md
docs/superpowers/plans/2026-07-20-project-initialization.md
docs/superpowers/plans/2026-07-20-tool-system.md
docs/superpowers/plans/2026-07-20-unified-llm-client.md
```

Keep the TypeScript migration design and this implementation plan.

- [ ] **Step 4: Remove local Python environments only after validating targets**

Run this PowerShell from the repository root:

```powershell
$workspace = (Resolve-Path -LiteralPath '.').Path
$targets = @('.venv', '.pytest_cache', '__pycache__')
foreach ($relative in $targets) {
  if (-not (Test-Path -LiteralPath $relative)) { continue }
  $resolved = (Resolve-Path -LiteralPath $relative).Path
  if (-not $resolved.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside workspace: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
```

Do not include `.env` in this operation.

- [ ] **Step 5: Verify pure-TypeScript state and commit**

Run:

```powershell
npm ci
npm run typecheck
npm test
npm run build
if (git ls-files '*.py' 'pyproject.toml' 'uv.lock' 'requirements.txt') { throw 'Python artifacts remain tracked' }
git diff --check
```

Expected: clean install/build/test succeeds and no tracked Python artifacts are printed.

```powershell
git add -A
git commit -m "refactor: complete TypeScript migration"
```

---

### Task 11: Final acceptance and single-root history replacement

**Files:**
- No content changes expected.
- Rewrite: local Git references and object database after acceptance.

**Interfaces:**
- Consumes: the verified TypeScript tree from Task 10.
- Produces: one parentless `master` commit containing the complete project.

- [ ] **Step 1: Run fresh acceptance before destructive history work**

Run:

```powershell
npm ci
npm run typecheck
npm test
npm run build
git diff --check
git status --short
git remote -v
```

Expected: all npm commands succeed, status is empty, and no remote is configured. Stop if status is dirty or any remote exists.

- [ ] **Step 2: Verify no other refs would preserve old history**

Run:

```powershell
$refs = @(git for-each-ref --format='%(refname)')
$unexpected = @($refs | Where-Object { $_ -ne 'refs/heads/master' })
if ($unexpected.Count -gt 0) {
  $unexpected
  throw 'Unexpected refs must be reviewed before history replacement'
}
```

Expected: no unexpected refs.

- [ ] **Step 3: Replace `master` with a parentless commit using the verified tree**

Use Git plumbing so the working tree is never emptied:

```powershell
$tree = git write-tree
if ($LASTEXITCODE -ne 0) { throw 'git write-tree failed' }
$rootCommit = 'feat: initialize TypeScript Kea Agent' | git commit-tree $tree
if ($LASTEXITCODE -ne 0 -or -not $rootCommit) { throw 'git commit-tree failed' }
git update-ref refs/heads/master $rootCommit
if ($LASTEXITCODE -ne 0) { throw 'git update-ref failed' }
```

- [ ] **Step 4: Expire recovery references and prune old objects**

This is intentionally irreversible and is authorized by the approved design:

```powershell
git reflog expire --expire=now --all
git gc --prune=now
```

- [ ] **Step 5: Verify the final repository**

Run:

```powershell
$count = git rev-list --count master
if ($count -ne '1') { throw "Expected one commit, found $count" }
$parents = git show -s --format='%P' master
if ($parents) { throw "Expected parentless root, found parents: $parents" }
if (git status --short) { throw 'Working tree is not clean' }
if (git ls-files '*.py' 'pyproject.toml' 'uv.lock' 'requirements.txt') { throw 'Python artifacts remain' }
npm ci
npm run typecheck
npm test
npm run build
git diff --check
git log --oneline --decorate --all
```

Expected: exactly one parentless `master` commit, no Python artifacts, clean worktree, and full npm acceptance succeeds.
