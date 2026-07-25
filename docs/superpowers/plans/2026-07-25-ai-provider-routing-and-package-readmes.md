# AI Provider Routing and Package READMEs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one `StreamFn` route across all providers configured at startup, preserve tool error state in agent history, and rewrite the ai/agent READMEs around their real package responsibilities.

**Architecture:** `createStreamFn()` remains the ai package's single entry point and builds a lazy adapter map for every configured provider. `DEFAULT_PROVIDER` selects only the returned default model; each request continues to route by `ModelConfig.provider`. The agent loop copies execution results into agent-owned message history, while documentation explains adjacent-layer translation instead of encouraging ai types to flow through every upper layer.

**Tech Stack:** TypeScript 7, Node.js 24, `node:test`, TypeBox, Markdown.

## Global Constraints

- Do not design or modify the future harness configuration system.
- Do not add a JSON configuration loader in this change.
- Do not change the `StreamFn`, `ModelConfig`, `Context`, or event shapes.
- Keep adapters lazy and reuse the adapter instance created for each configured provider.
- Preserve sequential tool execution.
- Treat `AgentMessage = Message` as an intentional current alias and `AgentToolCall` as an explicit parallel agent type.
- Preserve unrelated working-tree changes.

---

### Task 1: Multi-provider routing in `createStreamFn`

**Files:**
- Modify: `tests/ai/factory.test.ts`
- Modify: `src/ai/factory.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `Environment`, `ModelConfig`, `Adapter`
- Produces: unchanged `createStreamFn(options?): { stream: StreamFn; defaultModel: ModelConfig }`

- [ ] **Step 1: Replace the obsolete multiple-provider rejection test with failing default-selection tests**

Add tests covering:

```ts
test("multiple providers require DEFAULT_PROVIDER", () => {
  assert.throws(
    () => createStreamFn({
      env: {
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY: "b",
        MODEL_ID: "m",
      },
    }),
    /DEFAULT_PROVIDER/,
  );
});

test("DEFAULT_PROVIDER selects the default from configured providers", () => {
  const { defaultModel } = createStreamFn({
    env: {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      DEFAULT_PROVIDER: "openai",
      MODEL_ID: "gpt-test",
    },
  });
  assert.deepEqual(defaultModel, { provider: "openai", model: "gpt-test" });
});

test("DEFAULT_PROVIDER must name a configured provider", () => {
  assert.throws(
    () => createStreamFn({
      env: {
        ANTHROPIC_API_KEY: "a",
        DEFAULT_PROVIDER: "openai",
        MODEL_ID: "m",
      },
    }),
    /DEFAULT_PROVIDER.*openai.*not configured/,
  );
});
```

- [ ] **Step 2: Add a failing routing test using two real custom adapter objects**

Create two `ProviderConfig` objects with different environment keys. Each
adapter records the model passed to its `stream()` method and yields a valid
`done` event. Build one stream with both keys and call it once for each
provider:

```ts
test("one StreamFn routes each request by model.provider", async () => {
  const calls: string[] = [];
  const provider = (id: string, envApiKey: string): ProviderConfig => ({
    id,
    envApiKey,
    createAdapter: () => ({
      async *stream(model) {
        calls.push(`${id}/${model}`);
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [],
            model,
            stopReason: "stop",
            latencyMs: 0,
          },
        };
      },
    }),
  });

  const { stream } = createStreamFn({
    providers: [provider("first", "FIRST_KEY"), provider("second", "SECOND_KEY")],
    env: {
      FIRST_KEY: "a",
      SECOND_KEY: "b",
      DEFAULT_PROVIDER: "first",
      MODEL_ID: "default",
    },
  });

  for await (const _ of stream({ provider: "first", model: "one" }, { messages: [] })) void _;
  for await (const _ of stream({ provider: "second", model: "two" }, { messages: [] })) void _;

  assert.deepEqual(calls, ["first/one", "second/two"]);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```text
npm run build
node --test dist/tests/ai/factory.test.js
```

Expected failures:

- configured provider count still rejects the valid `DEFAULT_PROVIDER` case;
- the missing-default error does not mention `DEFAULT_PROVIDER`;
- the routing test cannot construct one stream with both providers.

- [ ] **Step 4: Implement deterministic default selection without restricting the adapter map**

In `createStreamFn()`:

```ts
const configured = allProviders.filter((provider) => env[provider.envApiKey]);
if (configured.length === 0) {
  throw new Error(
    "No LLM provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY",
  );
}

const requestedDefault = env["DEFAULT_PROVIDER"];
if (requestedDefault === undefined && configured.length > 1) {
  throw new Error(
    "Multiple LLM providers configured; set DEFAULT_PROVIDER",
  );
}

const defaultProvider = requestedDefault ?? configured[0]!.id;
if (!configured.some((provider) => provider.id === defaultProvider)) {
  throw new Error(
    `DEFAULT_PROVIDER '${defaultProvider}' is not configured`,
  );
}
```

Keep adapter creation over the entire `configured` array and return:

```ts
return {
  stream,
  defaultModel: { provider: defaultProvider, model: modelId },
};
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```text
npm run build
node --test dist/tests/ai/factory.test.js
```

Expected: all factory tests pass.

- [ ] **Step 6: Prove that the lazy wrapper reuses the loaded adapter**

Add a test that calls one `lazyAdapter` twice and asserts its loader ran once.
Run the focused factory test to observe RED, then memoize the loader promise
inside `lazyAdapter` and rerun to GREEN. Export `lazyAdapter` from
`factory.ts` for direct internal testing, but do not add it to `ai/index.ts`.

---

### Task 2: Preserve tool error state in agent history

**Files:**
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/agent/agent.test.ts`
- Modify: `src/agent/agent-loop.ts`

**Interfaces:**
- Consumes: `AgentToolResult`, `ToolResultMessage`, `Agent.state`
- Produces: tool history messages whose optional `isError` matches the execution result

- [ ] **Step 1: Tighten the existing registry-failure test**

In `"Registry failures are emitted and returned to the model"`, assert the
stored message, not only its content:

```ts
assert.deepEqual(history[2], {
  role: "tool",
  toolCallId: "c1",
  name: "missing",
  content: "Error: Unknown tool 'missing'",
  isError: true,
});
```

- [ ] **Step 2: Add an Agent regression test for `errorMessage`**

Use a two-turn `StreamFn`: the first turn returns a call to an unregistered
tool, and the second returns a normal assistant message. After consuming
`agent.prompt("run")`, assert:

```ts
assert.equal(agent.state.errorMessage, "Error: Unknown tool 'missing'");
```

- [ ] **Step 3: Run focused agent tests and verify RED**

Run:

```text
npm run build
node --test dist/tests/agent/agent-loop.test.js dist/tests/agent/agent.test.js
```

Expected:

- stored tool message lacks `isError`;
- `Agent.state.errorMessage` is `undefined`.

- [ ] **Step 4: Copy the execution error discriminator into history**

Change the tool message append in `runAgentLoop()` to:

```ts
context.messages.push({
  role: "tool",
  toolCallId: call.id,
  name: call.name,
  content: result.content,
  isError: result.isError,
} as AgentMessage);
```

- [ ] **Step 5: Run focused agent tests and verify GREEN**

Run:

```text
npm run build
node --test dist/tests/agent/agent-loop.test.js dist/tests/agent/agent.test.js
```

Expected: both test files pass.

---

### Task 3: Rewrite the ai and agent package READMEs

**Files:**
- Modify: `src/ai/README.md`
- Modify: `src/agent/README.md`

**Interfaces:**
- Documents: public exports from `src/ai/index.ts`, `src/agent/*.ts`, and `src/agent/tools/*.ts`
- Produces: concise package-level mental models and runnable examples

- [ ] **Step 1: Rewrite `src/ai/README.md` around one LLM turn**

Use this section order:

1. Responsibility and non-responsibilities.
2. `StreamFn` input/output diagram.
3. Provider configuration and routing semantics.
4. Message and tool protocol concepts.
5. Minimal call example using public exports.
6. Short custom-provider example.
7. Boundary with the agent package.

Required statements:

- ai does not retain conversation history;
- ai understands tool schemas/calls but never validates or executes them;
- every configured provider is registered at startup;
- one provider can be inferred, multiple require `DEFAULT_PROVIDER`;
- `DEFAULT_PROVIDER` affects only `defaultModel`;
- any configured provider is selected per request through `ModelConfig`;
- `done` and `error` carry the complete assistant message;
- configuration loading and agent-loop behavior are outside this package.

Remove:

- the exhaustive interface dump;
- the adapter/`ResolvedOptions` internals section;
- claims about which concrete upper-layer files import each type;
- claims that one function has no internal state;
- incomplete imports and non-runnable snippets.

- [ ] **Step 2: Rewrite `src/agent/README.md` around one agent run**

Use this section order:

1. Responsibility and run/turn terminology.
2. Agent-loop flow.
3. `runAgentLoop` versus `Agent`.
4. Package-owned parallel concepts and translation.
5. Executable tools and registry.
6. Event categories and lifecycle callbacks.
7. Cancellation limits.
8. Minimal runnable example.

Required statements:

- `runAgentLoop` is parameter-driven but not a pure function;
- it mutates the supplied history and performs LLM/tool effects;
- no tool call ends a run unless `onStop` forces continuation;
- tool calls execute sequentially;
- `AgentMessage` is currently an intentional alias of `ai.Message`;
- `AgentToolCall` is an agent-owned parallel structure translated from
  `ai.ToolCall`;
- `AgentTool` adds validation/execution to the adjacent ai `Tool` contract;
- package-level aliases and translations prevent transport concepts from
  leaking unchanged through multiple upper layers;
- `abort()` cancels an LLM stream and stops at safe loop boundaries but does
  not interrupt an already running tool.

Do not explain harness internals.

- [ ] **Step 3: Check README examples and claims against source**

Verify:

```text
src/ai/index.ts
src/ai/types.ts
src/ai/factory.ts
src/agent/types.ts
src/agent/agent.ts
src/agent/agent-loop.ts
src/agent/tools/types.ts
src/agent/tools/registry.ts
```

Confirm all names, imports, constructor parameters, event names, default
values, and cancellation statements match current code.

---

### Task 4: Final verification

**Files:**
- Verify all modified source, tests, and documentation files

**Interfaces:**
- Consumes: completed Tasks 1–3
- Produces: evidence that the implementation and documentation agree

- [ ] **Step 1: Run type checking**

Run:

```text
npm run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 2: Run the full test suite**

Run:

```text
npm test
```

Expected: every test passes, including the new provider-routing and tool-error
regressions.

- [ ] **Step 3: Check whitespace and working-tree scope**

Run:

```text
git diff --check
git status --short
git diff -- src/ai/factory.ts src/agent/agent-loop.ts tests/ai/factory.test.ts tests/agent/agent-loop.test.ts tests/agent/agent.test.ts src/ai/README.md src/agent/README.md
```

Expected:

- no whitespace errors;
- unrelated `.claude/settings.json` changes remain untouched;
- the diff contains only the approved source, test, and README changes plus
  the existing user edits in the two README files now intentionally replaced
  by the rewrite.

- [ ] **Step 4: Re-read the approved specification**

Compare the completed diff with:

```text
docs/superpowers/specs/2026-07-25-ai-provider-routing-and-package-readmes-design.md
```

Confirm every goal is implemented and every non-goal remains out of scope.
