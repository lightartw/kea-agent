# Core Simplification and Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify Kea's defensive framework code and provide one non-streaming and one streaming LLM operation, both supporting tools, with an Agent event stream for the CLI.

**Architecture:** `Tool` remains the only executable tool abstraction and exports OpenAI-format `ToolSchema` values through `ToolRegistry.schemas()`. Each provider adapter accepts that schema, implements `invoke()` plus `stream()`, accumulates complete streamed responses, and retains internal timeouts without caller cancellation. `runAgentTurn()` consumes LLM events, executes tools only after `response_done`, and yields four UI-facing Agent events while `main.ts` only handles the human input loop and rendering.

**Tech Stack:** Node.js 24, npm 11, ESM, strict TypeScript 7, Node built-in test runner, TypeBox, Anthropic SDK, OpenAI SDK, Google GenAI SDK.

## Global Constraints

- Work directly on `master`; do not create a worktree.
- Do not read, display, or commit `.env`.
- Keep `timeout`; remove caller-controlled `AbortSignal` propagation.
- Keep only basic functionality; omit future framework defenses and extensions.
- Keep `Tool` and `ToolSchema`; do not introduce `ToolDefinition`.
- Keep `ToolRegistry.unregister()`.
- Both `invoke()` and `stream()` support optional `ToolSchema[]`.
- Tool execution starts only after the provider emits a complete `response_done`.
- Tests must use fake SDK clients and must not access live providers or `.env`.
- Use test-first red-green-refactor for every behavior change.

---

### Task 1: LLM Contracts, Timeout Utility, and Error Surface

**Files:**
- Create: `src/utils/timeout.ts`
- Create: `tests/utils/timeout.test.ts`
- Modify: `src/llm-client/models.ts`
- Modify: `src/llm-client/client.ts`
- Modify: `src/llm-client/errors.ts`
- Modify: `tests/llm-client/client.test.ts`
- Delete: `src/utils/abort-signals.ts`
- Delete: `tests/utils/abort-signals.test.ts`

**Interfaces:**
- Produces: `LLMStreamEvent`, `LLMClient.invoke(messages, tools?, options?)`, `LLMClient.stream(messages, tools?, options?)`, and `runWithTimeout(seconds, operation)`.
- Removes: `LLMCallOptions`, `ResolvedLLMCallOptions`, caller signals, `invokeWithTools()`, `streamInvoke()`, exhaustive caller validation, and `LLMAuthenticationError`.

- [ ] **Step 1: Write failing contract and timeout tests**

Replace defense-only option/message/schema tests with tests that demonstrate the desired option merge and timeout behavior:

```ts
test("mergeOptions keeps typed call overrides", () => {
  assert.deepEqual(
    mergeOptions({ timeout: 120, maxTokens: 8_000 }, { timeout: 3 }),
    { timeout: 3, maxTokens: 8_000 },
  );
});

test("runWithTimeout supplies a signal and returns the operation result", async () => {
  let received: AbortSignal | undefined;
  const result = await runWithTimeout(1, async (signal) => {
    received = signal;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.ok(received instanceof AbortSignal);
});

test("runWithTimeout rejects when an operation does not settle", async () => {
  await assert.rejects(
    runWithTimeout(0.001, async () => new Promise(() => undefined)),
    TimeoutError,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run build && node --test dist/tests/llm-client/client.test.js dist/tests/utils/timeout.test.js`

Expected: compilation/test failure because `timeout.ts`, `runWithTimeout`, and the new LLM contract do not exist.

- [ ] **Step 3: Implement the minimal contracts**

Add the event type and replace the client surface:

```ts
export type LLMStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "response_done"; readonly response: LLMResponse };

export interface LLMClient {
  invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): Promise<LLMResponse>;
  stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent>;
}
```

Keep positive timeout and positive integer `maxTokens` validation in `mergeOptions()`, but remove unknown-key, comprehensive message, schema, and caller-signal validation. Implement `TimeoutError`, `timeoutMilliseconds()`, and:

```ts
export async function runWithTimeout<T>(
  seconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new TimeoutError("Operation timed out")),
    timeoutMilliseconds(seconds),
  );
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
```

Remove `LLMAuthenticationError`; authentication errors will later map to `LLMProviderError`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm run typecheck && npm run build && node --test dist/tests/llm-client/client.test.js dist/tests/utils/timeout.test.js`

Expected: PASS for the focused tests; adapter compilation failures are acceptable only while their task is actively being updated in the same red-green cycle.

- [ ] **Step 5: Commit the contract change**

```powershell
git add src/llm-client src/utils tests/llm-client/client.test.ts tests/utils
git commit -m "refactor: simplify llm contracts and timeout"
```

### Task 2: Tool Core, Registry, and Default Factory

**Files:**
- Modify: `src/tools/base.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/tools/errors.ts`
- Modify: `src/tools/index.ts`
- Create: `src/tools/factory.ts`
- Modify: `src/tools/builtin/bash.ts`
- Modify: `tests/tools/base.test.ts`
- Modify: `tests/tools/registry.test.ts`
- Modify: `tests/tools/bash.test.ts`
- Create: `tests/tools/factory.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `ToolSchema`, `runWithTimeout()`.
- Produces: `Tool<TObject>`, `ToolRegistry.schemas()`, `ToolRegistry.execute(call)`, retained `unregister(name)`, and `createToolRegistry(cwd)`.

- [ ] **Step 1: Write failing tests for the smaller tools API**

Update tests to assert:

```ts
test("Registry exports schemas in registration order and unregisters", () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));
  assert.deepEqual(registry.schemas().map((schema) => schema.function.name), ["first", "second"]);
  registry.unregister("first");
  assert.deepEqual(registry.schemas().map((schema) => schema.function.name), ["second"]);
});

test("Registry executes one ToolCall", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  assert.deepEqual(
    await registry.execute({ id: "c1", name: "echo", arguments: { value: "ok" } }),
    { content: "ok", isError: false },
  );
});

test("createToolRegistry installs Bash for the requested directory", () => {
  const registry = createToolRegistry(process.cwd());
  assert.deepEqual(registry.schemas().map((schema) => schema.function.name), ["bash"]);
});
```

Delete tests for deep cloning/freezing, `get()`, `names()`, malformed handcrafted tool metadata, non-string typed returns, caller cancellation, and Bash calls that bypass Registry with invalid typed input.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run build && node --test "dist/tests/tools/*.test.js"`

Expected: FAIL because `execute(call)` and `tools/factory.ts` are absent and old defensive behavior still shapes the API.

- [ ] **Step 3: Implement the minimal Tool and Registry surface**

Restrict tools to TypeBox object schemas and return the schema without recursive ownership machinery:

```ts
export abstract class Tool<TParameters extends TObject> {
  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
    readonly timeout: number | null = null,
  ) {}

  toSchema(): ToolSchema {
    return {
      type: "function",
      function: { name: this.name, description: this.description, parameters: this.parameters },
    };
  }

  abstract execute(arguments_: Static<TParameters>, timeoutSignal: AbortSignal): Promise<string>;
}
```

Registry registration compiles `tool.parameters`, rejects duplicate names, and preserves insertion order. `execute(call)` performs unknown-tool lookup, TypeBox validation, internal timeout execution, error normalization, and truncation. Configuration mistakes use ordinary `Error`; keep only `ToolExecutionError` in `errors.ts`. Add:

```ts
export function createToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new BashTool({ cwd }));
  return registry;
}
```

Keep Bash process `error`/`close`, dangerous fragments, cwd, and timeout signal handling; remove its duplicate `typeof command` check.

- [ ] **Step 4: Run tools tests and typecheck**

Run: `npm run typecheck && npm run build && node --test "dist/tests/tools/*.test.js"`

Expected: all tools tests PASS.

- [ ] **Step 5: Commit the tools simplification**

```powershell
git add src/tools tests/tools
git commit -m "refactor: simplify tool registry"
```

### Task 3: OpenAI Unified Invoke and Stream

**Files:**
- Modify: `src/llm-client/adapters/openai.ts`
- Modify: `tests/llm-client/openai.test.ts`
- Modify: `tests/llm-client/fixtures.ts`

**Interfaces:**
- Consumes: new `LLMClient`, `LLMStreamEvent`, `runWithTimeout()`.
- Produces: OpenAI `invoke(messages, tools?, options?)` and `stream(messages, tools?, options?)` with complete streamed tool calls.

- [ ] **Step 1: Write failing OpenAI streaming tests**

Use fake chunks that split arguments and assert the public event sequence:

```ts
test("OpenAI streams text and completes fragmented tool calls", async () => {
  const fake = new FakeOpenAIClient(asyncItems([
    { model: "gpt-test", choices: [{ delta: { content: "hi " } }] },
    { choices: [{ delta: { content: "there", tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{\"command\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"pwd\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ]));
  const events: LLMStreamEvent[] = [];
  for await (const event of new OpenAIAdapter(baseConfig, fake).stream(userMessages, [bashSchema])) {
    events.push(event);
  }
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "text_delta", "response_done"]);
  assert.deepEqual(events.at(-1)?.type, "response_done");
  assert.deepEqual(
    events.at(-1)?.type === "response_done" ? events.at(-1)?.response.toolCalls : [],
    [{ id: "c1", name: "bash", arguments: { command: "pwd" } }],
  );
});
```

Update non-stream tests to call `invoke(messages, tools)` and assert authentication becomes `LLMProviderError`. Remove caller abort and defensive early-iterator-close tests.

- [ ] **Step 2: Run the OpenAI tests and verify RED**

Run: `npm run build && node --test dist/tests/llm-client/openai.test.js`

Expected: FAIL because `stream()` and streamed tool-call accumulation are absent.

- [ ] **Step 3: Implement OpenAI invoke and stream**

Pass tools through unchanged when provided. Use one `runWithTimeout()` for request/stream lifetime. Accumulate `content`, indexed tool-call `id`, `name`, and argument text; parse arguments only when the iterator completes; emit non-empty text deltas immediately and exactly one final normalized response:

```ts
yield { type: "text_delta", text };

yield {
  type: "response_done",
  response: { model, content: content || null, toolCalls, usage, latencyMs, finishReason },
};
```

Keep external response shape checks and object-only parsed tool arguments. Translate SDK timeout errors to `LLMTimeoutError`, authentication to provider-specific `LLMProviderError`, and other failures to `LLMProviderError`.

- [ ] **Step 4: Run OpenAI tests and typecheck**

Run: `npm run typecheck && npm run build && node --test dist/tests/llm-client/openai.test.js`

Expected: PASS.

- [ ] **Step 5: Commit OpenAI changes**

```powershell
git add src/llm-client/adapters/openai.ts tests/llm-client/openai.test.ts tests/llm-client/fixtures.ts
git commit -m "feat: stream openai tool calls"
```

### Task 4: Anthropic Unified Invoke and Stream

**Files:**
- Modify: `src/llm-client/adapters/anthropic.ts`
- Modify: `tests/llm-client/anthropic.test.ts`

**Interfaces:**
- Consumes: the Task 1 contracts and common fixtures.
- Produces: Anthropic schema translation plus complete streamed text and tool calls.

- [ ] **Step 1: Write failing Anthropic streaming tests**

Model Anthropic content block events and assert delayed tool readiness:

```ts
const events: LLMStreamEvent[] = [];
for await (const event of adapter.stream(userMessages, [bashSchema])) events.push(event);
assert.deepEqual(events.map((event) => event.type), ["text_delta", "response_done"]);
const done = events.at(-1);
assert.equal(done?.type, "response_done");
assert.deepEqual(done?.type === "response_done" ? done.response.toolCalls : [], [
  { id: "c1", name: "bash", arguments: { command: "pwd" } },
]);
assert.deepEqual(fake.lastRequest.tools, [{
  name: "bash",
  description: "Run a shell command.",
  input_schema: bashSchema.function.parameters,
}]);
```

Use `content_block_start` for id/name, `content_block_delta` with `input_json_delta` fragments, `message_delta` for stop/usage, and `message_stop` to finish. Update non-stream calls to `invoke(messages, tools)` and remove caller cancellation/iterator cleanup tests.

- [ ] **Step 2: Run Anthropic tests and verify RED**

Run: `npm run build && node --test dist/tests/llm-client/anthropic.test.js`

Expected: FAIL on the missing new stream contract and tool accumulation.

- [ ] **Step 3: Implement Anthropic invoke and stream**

Convert `ToolSchema` to `{name, description, input_schema}`. Accumulate text blocks and tool-use blocks by provider block index, concatenate `partial_json`, parse object arguments after completion, map usage/finish reason, and emit exactly one `response_done`. Keep provider response checks and internal timeout behavior.

- [ ] **Step 4: Run Anthropic tests and typecheck**

Run: `npm run typecheck && npm run build && node --test dist/tests/llm-client/anthropic.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Anthropic changes**

```powershell
git add src/llm-client/adapters/anthropic.ts tests/llm-client/anthropic.test.ts
git commit -m "feat: stream anthropic tool calls"
```

### Task 5: Gemini Unified Invoke and Stream

**Files:**
- Modify: `src/llm-client/adapters/gemini.ts`
- Modify: `tests/llm-client/gemini.test.ts`

**Interfaces:**
- Consumes: the Task 1 contracts and common fixtures.
- Produces: Gemini schema translation plus complete streamed text and tool calls.

- [ ] **Step 1: Write failing Gemini streaming tests**

Use fake streamed response chunks with text, `functionCalls`, usage metadata, and finish reason:

```ts
const events: LLMStreamEvent[] = [];
for await (const event of adapter.stream(userMessages, [bashSchema])) events.push(event);
assert.deepEqual(events.map((event) => event.type), ["text_delta", "response_done"]);
const done = events.at(-1);
assert.equal(done?.type, "response_done");
assert.deepEqual(done?.type === "response_done" ? done.response.toolCalls : [], [
  { id: "gemini-call-0", name: "bash", arguments: { command: "pwd" } },
]);
assert.deepEqual(fake.lastRequest.config.tools, [{
  functionDeclarations: [{
    name: "bash",
    description: "Run a shell command.",
    parametersJsonSchema: bashSchema.function.parameters,
  }],
}]);
```

Update non-stream calls to `invoke(messages, tools)` and authentication expectations to `LLMProviderError`; remove caller cancellation and defensive iterator shutdown tests.

- [ ] **Step 2: Run Gemini tests and verify RED**

Run: `npm run build && node --test dist/tests/llm-client/gemini.test.js`

Expected: FAIL on the missing new stream behavior.

- [ ] **Step 3: Implement Gemini invoke and stream**

Convert schemas to Gemini declarations. During streaming, emit each non-empty `chunk.text`, accumulate text, normalize complete function calls from chunks with stable fallback ids, retain latest model/usage/finish data, and emit one `response_done` after iteration. Keep object-only argument validation and internal timeout handling.

- [ ] **Step 4: Run Gemini tests and typecheck**

Run: `npm run typecheck && npm run build && node --test dist/tests/llm-client/gemini.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Gemini changes**

```powershell
git add src/llm-client/adapters/gemini.ts tests/llm-client/gemini.test.ts
git commit -m "feat: stream gemini tool calls"
```

### Task 6: Asynchronous Selected-Adapter Factory

**Files:**
- Modify: `src/llm-client/factory.ts`
- Modify: `tests/llm-client/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: adapter `create*Adapter(config)` functions.
- Produces: `createLLMClient(options?, environment?): Promise<LLMClient>`.
- Removes: `LazyLLMClient`, `AdapterLoader`, `AdapterLoaders`, injected loaders, memoization.

- [ ] **Step 1: Write failing async factory tests**

Replace injected-loader tests with provider/configuration tests that await the factory and verify the selected concrete adapter:

```ts
test("createLLMClient asynchronously creates the selected adapter", async () => {
  const client = await createLLMClient(
    { provider: "openai", model: "m", apiKey: "k", baseUrl: null },
    {},
  );
  assert.ok(client instanceof OpenAIAdapter);
});
```

Retain provider detection, exactly-one-provider, explicit override, `baseUrl: null`, and import side-effect tests. Remove lazy delegation, loader failure memoization, and concurrent-first-call tests.

- [ ] **Step 2: Run factory/import tests and verify RED**

Run: `npm run build && node --test dist/tests/llm-client/factory.test.js dist/tests/import-smoke.test.js`

Expected: FAIL because the existing factory returns a lazy client synchronously.

- [ ] **Step 3: Implement direct dynamic selection**

Keep configuration resolution and use a small provider switch:

```ts
export async function createLLMClient(
  options: CreateLLMClientOptions = {},
  environment: LLMEnvironment = process.env,
): Promise<LLMClient> {
  const { selected, config } = resolveConfiguration(options, environment);
  switch (selected) {
    case "anthropic": return (await import("./adapters/anthropic.js")).createAnthropicAdapter(config);
    case "openai": return (await import("./adapters/openai.js")).createOpenAIAdapter(config);
    case "gemini": return (await import("./adapters/gemini.js")).createGeminiAdapter(config);
  }
}
```

Wrap dynamic import/construction failures once as `LLMProviderError` with the selected provider name.

- [ ] **Step 4: Run factory/import tests and typecheck**

Run: `npm run typecheck && npm run build && node --test dist/tests/llm-client/factory.test.js dist/tests/import-smoke.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the factory simplification**

```powershell
git add src/llm-client/factory.ts tests/llm-client/factory.test.ts tests/import-smoke.test.ts
git commit -m "refactor: create selected llm adapter eagerly"
```

### Task 7: Agent Turn Event Stream

**Files:**
- Create: `src/agent-turn.ts`
- Create: `tests/agent-turn.test.ts`
- Delete: `src/agent-loop.ts`
- Delete: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `LLMClient.stream()`, `ToolRegistry.schemas()`, `ToolRegistry.execute(call)`.
- Produces: `AgentEvent` and `runAgentTurn(messages, client, registry): AsyncIterable<AgentEvent>`.

- [ ] **Step 1: Write failing Agent event tests**

Cover text-only turns, tool turns, error results, event ordering, and history timing:

```ts
test("runAgentTurn streams text and ends once", async () => {
  const client: LLMClient = {
    async invoke() { return response("unused"); },
    async *stream() {
      yield { type: "text_delta", text: "hel" } as const;
      yield { type: "text_delta", text: "lo" } as const;
      yield { type: "response_done", response: response("hello") } as const;
    },
  };
  const events: AgentEvent[] = [];
  for await (const event of runAgentTurn(history, client, new ToolRegistry())) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "text_delta", "turn_end"]);
  assert.deepEqual(history.at(-1), { role: "assistant", content: "hello" });
});

test("runAgentTurn waits for response_done before starting tools", async () => {
  const observed: string[] = [];
  const client: LLMClient = {
    async invoke() { return response("unused"); },
    async *stream() {
      observed.push("response_done");
      yield {
        type: "response_done",
        response: response(null, [{ id: "c1", name: "observe", arguments: {} }]),
      } as const;
    },
  };
  const registry = new ToolRegistry();
  registry.register(new ObservingTool(() => observed.push("execute")));
  for await (const _event of runAgentTurn(history, client, registry)) {
    if (observed.includes("execute")) break;
  }
  assert.deepEqual(observed, ["response_done", "execute"]);
});

class ObservingTool extends Tool<typeof emptyParameters> {
  constructor(private readonly observe: () => void) {
    super("observe", "Record execution.", emptyParameters);
  }
  async execute(): Promise<string> {
    this.observe();
    return "ok";
  }
}
```

Also assert tool results are appended before the second model stream reads history, calls execute sequentially, Registry errors emit `tool_end`, and null final content is stored as `""`.

- [ ] **Step 2: Run Agent tests and verify RED**

Run: `npm run build && node --test dist/tests/agent-turn.test.js`

Expected: FAIL because `agent-turn.ts` and Agent events do not exist.

- [ ] **Step 3: Implement `runAgentTurn()`**

Define:

```ts
export type AgentEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: ToolResult }
  | { readonly type: "turn_end"; readonly response: LLMResponse };
```

For each model step, forward text deltas, capture exactly one `response_done`, append the complete assistant message, return with `turn_end` when there are no calls, otherwise execute calls sequentially with `tool_start`/`tool_end`, append result messages, and loop. Do not validate provider arguments again and do not accept a signal.

- [ ] **Step 4: Run Agent tests and typecheck**

Run: `npm run typecheck && npm run build && node --test dist/tests/agent-turn.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the Agent turn**

```powershell
git add src/agent-turn.ts tests/agent-turn.test.ts src/agent-loop.ts tests/agent-loop.test.ts
git commit -m "feat: stream agent turn events"
```

### Task 8: CLI, Public Exports, and Documentation

**Files:**
- Modify: `src/main.ts`
- Modify: `src/index.ts`
- Modify: `src/llm-client/index.ts`
- Modify: `README.md`
- Modify: `tests/import-smoke.test.ts`
- Create: `tests/main.test.ts`

**Interfaces:**
- Consumes: async `createLLMClient()`, tools-owned `createToolRegistry()`, and `runAgentTurn()`.
- Produces: a thin CLI renderer and coherent public exports/documentation.

- [ ] **Step 1: Write failing renderer/export tests**

Extract a small event renderer and test each event variant without starting readline:

```ts
test("renderAgentEvent writes text deltas without a duplicate final response", () => {
  const writes: string[] = [];
  renderAgentEvent({ type: "text_delta", text: "hello" }, (text) => writes.push(text), () => undefined);
  renderAgentEvent({ type: "turn_end", response: response("hello") }, (text) => writes.push(text), () => undefined);
  assert.deepEqual(writes, ["hello"]);
});
```

Test yellow tool-start formatting, tool-end result preview/error availability, and public imports for `runAgentTurn`, `createToolRegistry`, `LLMStreamEvent`, and `AgentEvent`.

- [ ] **Step 2: Run CLI/import tests and verify RED**

Run: `npm run build && node --test dist/tests/main.test.js dist/tests/import-smoke.test.js`

Expected: FAIL because the renderer and new exports are absent.

- [ ] **Step 3: Implement thin CLI integration**

Await the client factory, remove CLI abort controllers/SIGINT cancellation propagation, and render events directly:

```ts
const client = await createLLMClient();
const registry = createToolRegistry(process.cwd());

for await (const event of runAgentTurn(history, client, registry)) {
  renderAgentEvent(event, (text) => process.stdout.write(text), console.log);
}
console.log();
```

Keep readline's outer user-session loop and close on SIGINT. Export the new modules from `src/index.ts`; stop exporting deleted abort utilities. Update README examples to await the factory, pass optional schemas to both operations, consume `LLMStreamEvent`, describe Agent events, and document timeout without caller cancellation.

- [ ] **Step 4: Run CLI/import tests and all tests**

Run: `npm run typecheck && npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit integration and docs**

```powershell
git add src/main.ts src/index.ts src/llm-client/index.ts tests/main.test.ts tests/import-smoke.test.ts README.md
git commit -m "feat: render streamed agent events"
```

### Task 9: Final Simplification Audit and Verification

**Files:**
- Modify only files with an identified acceptance-criteria gap.

**Interfaces:**
- Verifies the complete design; produces no additional feature surface.

- [ ] **Step 1: Scan for removed concepts**

Run:

```powershell
rg -n "invokeWithTools|streamInvoke|LLMCallOptions|ResolvedLLMCallOptions|LLMAuthenticationError|ToolConfigurationError|combineAbortSignals|closeAsyncIterator|agentLoop|caller cancellation|AbortSignal.*public" src tests README.md
```

Expected: no stale production/test/docs references, apart from internal timeout `AbortSignal` parameters in `runWithTimeout`, adapters, `Tool.execute`, and Bash.

- [ ] **Step 2: Check API placement and dependency boundaries**

Run:

```powershell
rg -n "createToolRegistry|runAgentTurn|schemas\(\)|readonly ToolSchema\[\]" src tests README.md
```

Expected: the default registry factory is under `src/tools`, LLM calls receive schemas, and the Agent consumes both without importing concrete Bash code.

- [ ] **Step 3: Run fresh complete verification**

Run:

```powershell
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

Expected: every command exits 0; status contains only intentional changes if a final audit fix has not yet been committed.

- [ ] **Step 4: Commit any final audit fixes**

If Step 1 or Step 2 required an intentional correction, stage the exact modified files reported by `git status --short`, review `git diff --cached`, then commit:

```powershell
git add src tests README.md
git diff --cached
git commit -m "chore: finish core simplification"
```

If no files changed, do not create an empty commit.
