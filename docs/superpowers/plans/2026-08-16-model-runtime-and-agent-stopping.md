# Model Runtime and Agent Stopping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI 包的核心调用能力从单独的 `StreamFn` 提升为无模型选择状态的 `ModelRuntime`，并把 Agent 的动态停止策略统一到 `agent/stopping`，同时保持 Harness 对当前模型的权威所有权。

**Architecture:** `ModelRuntime` 只负责按显式 `ModelConfig` 发起 `stream()` 或等待 `complete()`；它不保存默认模型或当前模型。`AgentHarness` 持有当前模型并把 Runtime 交给 `runAgentLoop()`，Agent Loop 内部仅包装和调用 `runtime.stream`。正常 Turn 的动态停止判断通过 `agent/stopping` 完成；Abort、错误和 `maxTurns` 等硬限制仍由 Agent Loop 直接执行。

**Tech Stack:** TypeScript 7、Node.js 24、原生 `node:test`、现有 `Events.intercept()`、现有 provider Adapter。

## Global Constraints

- 修改必须少量、增量，不重构无关代码，不新增与职责无关的实体。
- 不恢复 `titleGenerator`，不实现 Session 自动标题，不实现 compaction。
- 本计划只建立 `complete()` 基础能力，不注册任何 AI `agent/stopping` 监听器。
- 不实现 steering、follow-up，也不保留 `agent/stopping` 注入消息的旧语义。
- Pi 的开发中 AgentHarness 仅作为设计参考，不把尚未实现的调用链当作现有事实。
- `ModelRuntime` 不保存当前模型、默认模型或 Session 状态；每次调用必须显式接收 `ModelConfig`。
- `AgentHarness.currentModel` 是进程存活期间的权威运行状态；Session `model_selection` 只负责记录和恢复。
- `modelConfig` 是 Harness 和 Project 构造配置字段名；Agent Loop 内现有 `config.model` 保持不变，因为它表示当前 Run 使用的模型。
- `agent/stopping` 是唯一动态停止策略扩展点；不再增加 `shouldStop` 或 `shouldStopAfterTurn` config 回调。
- `maxTurns` 是 `AgentLoopConfig` 中的可选硬限制，监听器不能覆盖它。
- 不增加第三方依赖。
- 所有新增公开类型必须通过现有包级 `index.ts` 导出，并由 import smoke test 覆盖。

---

## File Map

### AI Runtime

- `src/core/ai/types.ts`：定义 `ModelRuntime`，删除 AI 包公开的 `StreamFn`。
- `src/core/ai/factory.ts`：把 `createStreamFn()` 改为 `createModelRuntime()`，创建 Runtime 并实现 `complete()`。
- `src/core/ai/index.ts`：公开导出 `ModelRuntime` 与 `createModelRuntime()`。
- `tests/ai/factory.test.ts`：验证 Runtime 创建、provider 路由和 `complete()` 终止语义。
- `tests/ai/fixtures.ts`：删除未使用的 `fakeStreamFn`。
- `tests/fixtures/model-runtime.ts`：为 Agent、Harness 和 coding-agent 测试把测试流包装成完整 `ModelRuntime`。

### Agent Loop

- `src/core/agent/types.ts`：为 `AgentLoopConfig` 增加可选 `maxTurns`。
- `src/core/agent/events.ts`：把 `agent/stopping` 改为输入完整 Turn 结果并返回 `boolean`。
- `src/core/agent/agent-loop.ts`：接收 `ModelRuntime`，删除 `shouldContinue()`，执行硬限制和 stopping intercept。
- `tests/agent/agent-loop.test.ts`：验证 Runtime 调用、事件顺序、默认停止和最大 Turn。
- `tests/agent/control-events.test.ts`：验证 stopping 输入、覆盖默认结果、提前停止和信号传播。

### Harness and Application Wiring

- `src/core/harness/types.ts`：将 `HarnessConfig` 改为 `runtime + modelConfig`。
- `src/core/harness/agent-harness.ts`：保存 Runtime，继续保存 `currentModel`，调用新的 Agent Loop 签名。
- `src/coding-agent/types.ts`：将 `CreateProjectConfig` 改为 `runtime + modelConfig`。
- `src/coding-agent/factory.ts`：把 Project 配置传给每个新 Harness。
- `src/main.ts`：使用 `createModelRuntime()` 启动应用。
- `tests/harness/agent-harness.test.ts`：迁移 Harness fixture，保持模型恢复和切换断言。
- `tests/coding-agent/factory.test.ts`：迁移 Project fixture 和全部自定义测试流。
- `tests/main.test.ts`：迁移直接构造 Harness 的 smoke test。
- `tests/import-smoke.test.ts`：验证新的 AI 公开边界。

### Documentation

- `src/core/ai/README.md`：以 `ModelRuntime` 为核心重写调用边界和 `complete()`。
- `src/core/agent/README.md`：说明 Runtime、Turn 停止检查点和硬限制。
- `src/core/events/README.md`：更新 `agent/stopping` 时序与 boolean 契约。
- `src/core/harness/README.md`：更新 Harness 配置和模型所有权说明。
- `src/coding-agent/README.md`：更新组合根示例和 Project 配置。

---

### Task 1: Introduce the stateless ModelRuntime

**Files:**

- Create: `tests/fixtures/model-runtime.ts`
- Modify: `src/core/ai/types.ts`
- Modify: `src/core/ai/factory.ts`
- Modify: `src/core/ai/index.ts`
- Modify: `tests/ai/factory.test.ts`
- Modify: `tests/ai/fixtures.ts`
- Test: `tests/ai/factory.test.ts`

**Interfaces:**

- Consumes: 现有 `ModelConfig`、`Context`、`StreamOptions`、`StreamChunk`、`AssistantMessage` 和 provider `Adapter.stream()`。
- Produces:

```ts
export interface ModelRuntime {
  stream(
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk>;

  complete(
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): Promise<AssistantMessage>;
}

export function createModelRuntime(
  options?: { providers?: ProviderConfig[]; env?: Environment },
): { runtime: ModelRuntime; modelConfig: ModelConfig };
```

- Produces test-only helper:

```ts
export type TestStream = ModelRuntime["stream"];

export function runtimeFromStream(stream: TestStream): ModelRuntime;
```

- Removes: `StreamFn` from `src/core/ai/types.ts` and AI package exports; `createStreamFn()` and `{ stream, defaultModel }` from the factory API。

- [ ] **Step 1: Rewrite the factory tests against the new public contract**

In `tests/ai/factory.test.ts`, replace `createStreamFn` imports and result destructuring with `createModelRuntime`, `runtime`, and `modelConfig`. Keep the existing provider selection and lazy adapter assertions, but call `runtime.stream(...)` instead of a standalone function.

Add these focused tests using a custom provider whose Adapter yields controlled chunks:

```ts
test("complete returns the terminal assistant message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "test-model",
    stopReason: "stop",
    latencyMs: 0,
  };
  const { runtime, modelConfig } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() {
          yield { type: "text_delta" as const, text: "done" };
          yield { type: "done" as const, message: terminal };
        },
      }),
    }],
    env: { TEST_KEY: "key", MODEL_ID: "test-model" },
  });

  assert.equal(
    await runtime.complete(modelConfig, { messages: [] }),
    terminal,
  );
});

test("complete returns an error terminal message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [],
    model: "test-model",
    stopReason: "error",
    errorMessage: "provider failed",
    latencyMs: 0,
  };
  const { runtime, modelConfig } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() {
          yield { type: "error" as const, message: terminal };
        },
      }),
    }],
    env: { TEST_KEY: "key", MODEL_ID: "test-model" },
  });

  assert.equal(
    await runtime.complete(modelConfig, { messages: [] }),
    terminal,
  );
});

test("complete rejects when the stream has no terminal chunk", async () => {
  const { runtime, modelConfig } = createModelRuntime({
    providers: [{
      id: "test",
      envApiKey: "TEST_KEY",
      createAdapter: () => ({
        async *stream() {
          yield { type: "text_delta" as const, text: "partial" };
        },
      }),
    }],
    env: { TEST_KEY: "key", MODEL_ID: "test-model" },
  });

  await assert.rejects(
    runtime.complete(modelConfig, { messages: [] }),
    /without a done or error terminal chunk/,
  );
});
```

- [ ] **Step 2: Run the AI test build and verify the new API is missing**

Run:

```powershell
npm run build
```

Expected: FAIL with TypeScript errors that `createModelRuntime` and `ModelRuntime` are not exported and that `createStreamFn` no longer matches the rewritten tests.

- [ ] **Step 3: Replace StreamFn with ModelRuntime in AI types**

In `src/core/ai/types.ts`, remove the `StreamFn` alias and add exactly:

```ts
export interface ModelRuntime {
  stream(
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk>;

  complete(
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): Promise<AssistantMessage>;
}
```

Do not add `defaultModel`, `currentModel`, provider registries, Session references, or mutable selection methods to this interface.

- [ ] **Step 4: Implement createModelRuntime and complete**

In `src/core/ai/factory.ts`, retain the existing provider discovery, validation, lazy Adapter creation, and option resolution unchanged. Rename only the public factory and build one Runtime around the existing routing closure:

```ts
export function createModelRuntime(
  options?: { providers?: ProviderConfig[]; env?: Environment },
): { runtime: ModelRuntime; modelConfig: ModelConfig } {
  // Existing environment and provider setup remains here.

  const stream = async function* (
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk> {
    const adapter = getAdapter(modelConfig.provider);
    yield* adapter.stream(
      modelConfig.model,
      context,
      resolveOptions(options),
    );
  };

  const runtime: ModelRuntime = {
    stream,
    async complete(modelConfig, context, options) {
      for await (const event of stream(modelConfig, context, options)) {
        if (event.type === "done" || event.type === "error") {
          return event.message;
        }
      }
      throw new Error(
        "Model stream ended without a done or error terminal chunk",
      );
    },
  };

  return {
    runtime,
    modelConfig: { provider: defaultProvider, model: modelId },
  };
}
```

`complete()` 必须复用同一个 `stream` 路由，不直接访问 Adapter，也不复制 provider/auth 选择逻辑。

- [ ] **Step 5: Update AI exports and test fixtures**

In `src/core/ai/index.ts`:

```ts
export type {
  AssistantMessage,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  ModelRuntime,
  StopReason,
  StreamChunk,
  StreamOptions,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "./types.js";
export { createModelRuntime } from "./factory.js";
export type { ProviderConfig } from "./factory.js";
```

In `tests/ai/fixtures.ts`, remove the `StreamFn` import and the unused `fakeStreamFn` export. Do not replace it with a Runtime because no current AI adapter test consumes it.

Create `tests/fixtures/model-runtime.ts`:

```ts
import type { ModelRuntime } from "../../src/core/ai/types.js";

export type TestStream = ModelRuntime["stream"];

export function runtimeFromStream(stream: TestStream): ModelRuntime {
  return {
    stream,
    async complete() {
      throw new Error("Unexpected complete() call in stream-only test");
    },
  };
}
```

This helper is test-only. Production code must not gain a `runtimeFromStream()` compatibility API.

- [ ] **Step 6: Run the focused AI tests**

Run:

```powershell
npm run build
node --test dist/tests/ai/factory.test.js
```

Expected: build may still FAIL only in Agent/Harness/coding-agent files that still import `StreamFn`; `tests/ai/factory.test.ts` itself must have no remaining AI Runtime type errors. After Task 2 and Task 3 migrate downstream callers, the focused test command must PASS.

- [ ] **Step 7: Commit the AI Runtime boundary**

After downstream compile failures are known and limited to the files listed in Task 2 and Task 3, commit only the AI Runtime and its tests:

```powershell
git add src/core/ai/types.ts src/core/ai/factory.ts src/core/ai/index.ts tests/ai/factory.test.ts tests/ai/fixtures.ts tests/fixtures/model-runtime.ts
git commit -m "refactor(ai): introduce model runtime"
```

Expected: one commit containing no Agent, Harness, coding-agent, title, compaction, or documentation behavior changes.

---

### Task 2: Move Agent streaming and stop policy onto Runtime and agent/stopping

**Files:**

- Modify: `src/core/agent/types.ts`
- Modify: `src/core/agent/events.ts`
- Modify: `src/core/agent/agent-loop.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/agent/control-events.test.ts`
- Test: `tests/agent/agent-loop.test.ts`
- Test: `tests/agent/control-events.test.ts`

**Interfaces:**

- Consumes: `ModelRuntime` and `runtimeFromStream()` from Task 1。
- Produces:

```ts
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly maxTurns?: number;
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
  readonly events: Events;
  readonly run: AgentRunIdentity;
}

export async function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  runtime: ModelRuntime,
  signal?: AbortSignal,
): Promise<void>;
```

- Produces event contract:

```ts
"agent/stopping": InterceptEvent<
  AgentRunIdentity & {
    readonly message: AgentMessage;
    readonly toolResults: readonly AgentMessage[];
    readonly messages: readonly AgentMessage[];
  },
  boolean
>;
```

- Removes: `shouldContinue()` and the ability for `agent/stopping` to return an `AgentMessage`。

- [ ] **Step 1: Add tests for the new stopping checkpoint**

In `tests/agent/agent-loop.test.ts`, import `ModelRuntime` only where needed and wrap every existing test stream with `runtimeFromStream(stream)` before passing it to `runAgentLoop()`.

Update the successful two-Turn lifecycle assertion so `agent/stopping` appears after both normal `agent/turn-end` events:

```ts
assert.deepEqual(factOrder, [
  "agent/turn-start",
  "agent/tool-call",
  "tools/pre-execute",
  "tools/execute",
  "tools/post-execute",
  "agent/tool-result",
  "agent/turn-end",
  "agent/stopping",
  "agent/turn-start",
  "agent/turn-end",
  "agent/stopping",
]);
```

The observer must preserve the intercept chain:

```ts
events.on("agent/stopping", (input, proceed) => {
  factOrder.push("agent/stopping");
  return proceed(input);
});
```

Add a hard-limit test:

```ts
test("maxTurns stops before another model request", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "noop",
    arguments: {},
  };
  let requests = 0;
  const stream: TestStream = async function* () {
    requests += 1;
    yield { type: "toolcall_start", id: call.id, name: call.name };
    yield { type: "toolcall_end", toolCall: call };
    yield { type: "done", message: assistantMsg("", [call]) };
  };

  await runAgentLoop(
    "run",
    memoryContext(registry),
    makeConfig({ maxTurns: 1 }),
    runtimeFromStream(stream),
  );

  assert.equal(requests, 1);
});
```

- [ ] **Step 2: Replace the old message-injection stopping tests**

In `tests/agent/control-events.test.ts`, delete `"agent/stopping continues when it returns a message"`. Replace it with two tests that exercise the boolean policy directly.

First, a listener can force another Turn even when the default would stop:

```ts
test("agent/stopping can override the default stop decision", async () => {
  const events = new Events();
  let checks = 0;
  events.on("agent/stopping", async (input, proceed) => {
    checks += 1;
    const defaultDecision = await proceed(input);
    return checks === 1 ? false : defaultDecision;
  });
  let requests = 0;

  await runAgentLoop(
    "start",
    memoryContext(),
    makeConfig(events),
    runtimeFromStream(async function* () {
      requests += 1;
      yield {
        type: "done",
        message: assistantMsg(`answer-${requests}`),
      };
    }),
  );

  assert.equal(requests, 2);
  assert.equal(checks, 2);
});
```

Second, a listener can stop after a Tool Turn before the next model request:

```ts
test("agent/stopping can stop after a tool Turn", async () => {
  const events = new Events();
  events.on("agent/stopping", () => true);
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "noop",
    arguments: {},
  };
  let requests = 0;

  await runAgentLoop(
    "run",
    memoryContext(tools),
    makeConfig(events),
    runtimeFromStream(async function* () {
      requests += 1;
      yield { type: "toolcall_start", id: call.id, name: call.name };
      yield { type: "toolcall_end", toolCall: call };
      yield { type: "done", message: assistantMsg("", [call]) };
    }),
  );

  assert.equal(requests, 1);
  assert.equal(tool.ran, true);
});
```

- [ ] **Step 3: Add an exact stopping-input assertion**

In `tests/agent/control-events.test.ts`, add:

```ts
test("agent/stopping receives the completed Turn and history", async () => {
  const events = new Events();
  const seen: Array<{
    message: AgentMessage;
    toolResults: readonly AgentMessage[];
    messages: readonly AgentMessage[];
  }> = [];
  events.on("agent/stopping", (input, proceed) => {
    seen.push({
      message: input.message,
      toolResults: input.toolResults,
      messages: input.messages,
    });
    return proceed(input);
  });

  await runAgentLoop(
    "hello",
    memoryContext(),
    makeConfig(events),
    runtimeFromStream(streamFnWithEvents([
      [{ type: "done", message: assistantMsg("done") }],
    ])),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.message.role, "assistant");
  assert.deepEqual(seen[0]?.toolResults, []);
  assert.deepEqual(
    seen[0]?.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});
```

Update the shared-signal assertion: `agent/stopping` now occurs after the Tool Turn and again after the final Turn, so the expected listener sequence must contain two `stopping` entries when the default policy is preserved.

- [ ] **Step 4: Run the focused Agent build and confirm contract failures**

Run:

```powershell
npm run build
```

Expected: FAIL because `AgentLoopConfig` lacks `maxTurns`, `runAgentLoop()` still accepts `StreamFn`, and `agent/stopping` still returns `AgentMessage | undefined`.

- [ ] **Step 5: Add maxTurns to AgentLoopConfig**

In `src/core/agent/types.ts`, add only this field after `model`:

```ts
/** Hard upper bound for completed model Turns in this Run. */
readonly maxTurns?: number;
```

Do not add a callback to `AgentLoopConfig`.

- [ ] **Step 6: Change the agent/stopping declaration**

In `src/core/agent/events.ts`, replace the existing declaration with:

```ts
"agent/stopping": InterceptEvent<
  AgentRunIdentity & {
    readonly message: AgentMessage;
    readonly toolResults: readonly AgentMessage[];
    readonly messages: readonly AgentMessage[];
  },
  boolean
>;
```

No new stop-decision union, class, reason enum, or follow-up message field is needed.

- [ ] **Step 7: Make Agent Loop consume ModelRuntime**

In `src/core/agent/agent-loop.ts`:

1. Replace the `StreamFn` import with `ModelRuntime`.
2. Change the fourth parameter to `runtime: ModelRuntime`.
3. Bind its stream capability once near the start of the function:

```ts
const stream = runtime.stream.bind(runtime);
```

4. Replace the provider request with:

```ts
for await (const event of stream(
  config.model,
  llmContext,
  signal === undefined ? {} : { signal },
)) {
  // Existing event handling remains unchanged.
}
```

`runtime.complete()` must not be called or referenced by Agent Loop.

- [ ] **Step 8: Centralize dynamic stop policy in agent/stopping**

Delete `shouldContinue()` entirely. Add `let completedTurns = 0;` immediately before the main `while` loop.

After `agent/turn-end` has been emitted for a normal terminal `done` message:

```ts
completedTurns += 1;
if (
  config.maxTurns !== undefined &&
  completedTurns >= config.maxTurns
) return;

const shouldStop = await config.events.intercept(
  "agent/stopping",
  {
    ...config.run,
    message: turnMessage,
    toolResults,
    messages: [...context.messages],
  },
  async (value) => value.toolResults.length === 0,
  signal,
);
if (shouldStop) return;
```

The hard `maxTurns` check intentionally runs before the intercept, so no listener or future AI request can bypass or waste work beyond the hard limit. Existing `error` and `aborted` terminal chunks continue to emit `agent/turn-end` and return directly without invoking `agent/stopping`.

- [ ] **Step 9: Migrate all Agent tests to Runtime fixtures**

In both Agent test files:

- remove `StreamFn` imports;
- import `TestStream` and `runtimeFromStream` from `../fixtures/model-runtime.js`;
- change helper return types from `StreamFn` to `TestStream`;
- wrap the fourth `runAgentLoop()` argument with `runtimeFromStream(...)`;
- change stopping observers that only record facts to call and return `proceed(input)`;
- preserve tests where a stopping listener deliberately returns `true` or `false` without calling `proceed()`.

Do not add production compatibility overloads merely to keep old tests compiling.

- [ ] **Step 10: Run the focused Agent tests**

Run:

```powershell
npm run build
node --test dist/tests/agent/agent-loop.test.js
node --test dist/tests/agent/control-events.test.js
```

Expected: both test files PASS. Remaining compile failures, if any, must be limited to Harness, coding-agent, main, or their tests still using the old config shape.

- [ ] **Step 11: Commit the Agent stopping checkpoint**

```powershell
git add src/core/agent/types.ts src/core/agent/events.ts src/core/agent/agent-loop.ts tests/agent/agent-loop.test.ts tests/agent/control-events.test.ts
git commit -m "refactor(agent): centralize stopping policy"
```

Expected: one commit that changes Agent behavior and tests, without Harness wiring or README edits.

---

### Task 3: Wire Runtime through Harness, Project, and the application entry point

**Files:**

- Modify: `src/core/harness/types.ts`
- Modify: `src/core/harness/agent-harness.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/main.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/import-smoke.test.ts`
- Test: `tests/harness/agent-harness.test.ts`
- Test: `tests/coding-agent/factory.test.ts`
- Test: `tests/main.test.ts`
- Test: `tests/import-smoke.test.ts`

**Interfaces:**

- Consumes: `ModelRuntime`, `ModelConfig`, `createModelRuntime()`, new `runAgentLoop(..., runtime, ...)`, and `runtimeFromStream()`。
- Produces:

```ts
export interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: Events;
}

export interface CreateProjectConfig {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly systemPrompt?: string;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}
```

- Preserves: `AgentHarness.model`, `switchModel()`, Session model restoration, one active Run, tool registry, Events identity, and system prompt behavior。

- [ ] **Step 1: Migrate Harness tests to the new constructor contract**

In `tests/harness/agent-harness.test.ts`:

- replace the `StreamFn` import with `TestStream` and `runtimeFromStream`;
- rename fixture options from `streamFn?: StreamFn` to `stream?: TestStream`;
- construct Harness with:

```ts
const harness = new AgentHarness({
  session: options.session ?? memorySession(),
  runtime: runtimeFromStream(options.stream ?? stream),
  modelConfig: modelA,
  toolRegistry: new AgentToolRegistry(),
  systemPrompt: options.systemPrompt ?? "system",
  events,
});
```

- update direct constructor sites identically;
- keep the existing model restoration assertion unchanged:

```ts
assert.deepEqual(harness.model, modelB);
await harness.switchModel(modelA);
assert.deepEqual(harness.model, modelA);
assert.deepEqual(session.modelSelection(), modelA);
```

This proves the rename to `modelConfig` did not move model authority into Runtime or Session.

- [ ] **Step 2: Migrate Project and entry-point tests**

In `tests/coding-agent/factory.test.ts`:

- rename `oneTurnStream` only if clarity improves; it may remain a test-local stream;
- change `StreamFn` annotations to `TestStream`;
- change the shared fixture to:

```ts
function createProjectAt(
  keaHome: string,
  directory: string,
  options: {
    stream?: TestStream;
    systemPrompt?: string;
    interactions?: CodingAgentInteractions;
  } = {},
) {
  return createProject({
    keaHome,
    directory,
    runtime: runtimeFromStream(options.stream ?? oneTurnStream),
    modelConfig: model,
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: options.systemPrompt }
      : {}),
    ...(options.interactions !== undefined
      ? { interactions: options.interactions }
      : {}),
  });
}
```

- at direct `createProject()` sites, wrap the test stream in `runtimeFromStream()` and rename `model` to `modelConfig`;
- update the recovery model test to pass `modelConfig: { provider: "test", model: "model-2" }` while preserving the existing `switchModel()` assertion.

In `tests/main.test.ts`, build the Harness with `runtime: runtimeFromStream(stream)` and `modelConfig`.

In `tests/import-smoke.test.ts`, import `ModelRuntime` from `src/core/ai/index.js` and include it in `PublicAiTypes`:

```ts
import type {
  ModelRuntime,
  StreamChunk,
} from "../src/core/ai/index.js";

type PublicAiTypes = [ModelRuntime, StreamChunk];
```

- [ ] **Step 3: Run the build and verify the old production config still fails**

Run:

```powershell
npm run build
```

Expected: FAIL where `HarnessConfig`, `CreateProjectConfig`, `AgentHarness`, and `main.ts` still require `streamFn` or `model`.

- [ ] **Step 4: Replace HarnessConfig fields**

In `src/core/harness/types.ts`, use:

```ts
import type { ModelConfig, ModelRuntime } from "../ai/types.js";

export interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: Events;
}
```

Do not add a second model field or a Runtime getter.

- [ ] **Step 5: Store Runtime and retain currentModel in AgentHarness**

In `src/core/harness/agent-harness.ts`:

```ts
private readonly runtime: ModelRuntime;
private currentModel: ModelConfig;
```

Constructor assignments:

```ts
this.runtime = config.runtime;
this.currentModel =
  config.session.modelSelection() ?? config.modelConfig;
```

The Run invocation must pass `this.runtime`:

```ts
await runAgentLoop(
  input,
  {
    systemPrompt: this.systemPrompt,
    messages,
    tools: this.toolRegistry,
    appendMessage: async (message) => {
      await this.session.append({ type: "message", message });
      messages.push(message);
    },
  },
  config,
  this.runtime,
  abortController.signal,
);
```

Keep `createLoopConfig()` returning `model: this.currentModel`. Keep `switchModel()` persistence-before-state-update ordering unchanged.

- [ ] **Step 6: Replace CreateProjectConfig and factory wiring**

In `src/coding-agent/types.ts`, replace the two AI fields only:

```ts
readonly runtime: ModelRuntime;
readonly modelConfig: ModelConfig;
```

In `src/coding-agent/factory.ts`, construct each Harness with:

```ts
return new AgentHarness({
  session,
  runtime: config.runtime,
  modelConfig: config.modelConfig,
  toolRegistry: createAgentToolRegistry(definitions, toolContext),
  systemPrompt: formatSystemPrompt(
    config.systemPrompt ?? CODING_SYSTEM_PROMPT,
    session.metadata.cwd,
    new Date(),
  ),
  events,
});
```

Do not store Runtime inside Session or Repository.

- [ ] **Step 7: Update the application composition root**

In `src/main.ts`:

```ts
import { createModelRuntime } from "./core/ai/factory.js";

const { runtime, modelConfig } = createModelRuntime();
const project = await createProject({
  keaHome,
  runtime,
  modelConfig,
  interactions: cli.interactions,
});
```

Keep dotenv loading, CLI lifecycle, KEA_HOME selection, Session continuation, and error handling unchanged.

- [ ] **Step 8: Run focused Harness and coding-agent tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/agent-harness.test.js
node --test dist/tests/coding-agent/factory.test.js
node --test dist/tests/main.test.js
node --test dist/tests/import-smoke.test.js
```

Expected: all four test files PASS. Model restoration, model switching, abort, Project creation, tool execution, public imports, and CLI rendering retain their previous behavior.

- [ ] **Step 9: Search production code for the removed boundary**

Run:

```powershell
rg -n "createStreamFn|defaultModel|StreamFn|streamFn|_streamFn" src -g "*.ts"
```

Expected: no matches.

Run:

```powershell
rg -n "runtime|modelConfig|currentModel" src/core/harness src/coding-agent src/main.ts -g "*.ts"
```

Expected: Runtime is passed through Harness/Project; `currentModel` appears only in Harness; `modelConfig` appears as construction input, not mutable Runtime state.

- [ ] **Step 10: Commit Runtime wiring**

```powershell
git add src/core/harness/types.ts src/core/harness/agent-harness.ts src/coding-agent/types.ts src/coding-agent/factory.ts src/main.ts tests/harness/agent-harness.test.ts tests/coding-agent/factory.test.ts tests/main.test.ts tests/import-smoke.test.ts
git commit -m "refactor(harness): accept model runtime"
```

Expected: one integration commit with no README changes and no title, compaction, steering, or follow-up implementation.

---

### Task 4: Align package documentation and verify the complete boundary

**Files:**

- Modify: `src/core/ai/README.md`
- Modify: `src/core/agent/README.md`
- Modify: `src/core/events/README.md`
- Modify: `src/core/harness/README.md`
- Modify: `src/coding-agent/README.md`
- Test: all files under `tests/**/*.test.ts`

**Interfaces:**

- Consumes: all production interfaces finalized in Tasks 1–3。
- Produces: documentation that describes only implemented behavior and explicitly marks future AI stopping/title/compaction behavior as absent。

- [ ] **Step 1: Rewrite the AI README around ModelRuntime**

In `src/core/ai/README.md`, replace every `createStreamFn`/`StreamFn` example with:

```ts
import {
  createModelRuntime,
  type Context,
} from "./core/ai/index.js";

const { runtime, modelConfig } = createModelRuntime();
const context: Context = {
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of runtime.stream(modelConfig, context)) {
  // Consume streaming events.
}

const message = await runtime.complete(modelConfig, context);
```

The prose must state:

- Runtime owns provider routing and request execution, not model selection;
- `modelConfig` returned by the factory is application startup configuration;
- `complete()` consumes the same stream path and returns the `done` or `error` terminal assistant message;
- title generation, compaction, and stop decisions do not belong to AI;
- switching provider/model never requires rebuilding Runtime when both providers are configured.

Remove the old public-boundary table row naming `StreamFn`.

- [ ] **Step 2: Update Agent and Events README stopping semantics**

In `src/core/agent/README.md`, update the `runAgentLoop()` signature to accept `ModelRuntime`. Replace all claims that `agent/stopping` occurs only when no Tool Result exists or returns a message.

Document the implemented order:

```text
agent/turn-end
maxTurns hard-limit check
agent/stopping intercept
next agent/turn-start, or Run return
```

State that the default stopping handler returns `true` when `toolResults.length === 0`. State that a listener may return a different boolean, and may later call `runtime.complete()` through a closure, but no such AI listener is implemented by core.

In `src/core/events/README.md`, replace the old flow:

```text
shouldContinue() decides internally
agent/stopping (only when the loop would otherwise stop)
```

with:

```text
agent/turn-end
hard maxTurns check
agent/stopping -> boolean
```

Explain that Emit events observe facts, while this Intercept event controls a pending stop decision.

- [ ] **Step 3: Update Harness and coding-agent README configuration**

In `src/core/harness/README.md`, update constructor examples and the `HarnessConfig` listing to `runtime` and `modelConfig`. Preserve the existing Session explanation, and state explicitly:

```text
modelConfig initializes a Session that has no recorded model selection.
currentModel is the live authority after construction.
model_selection is the durable record used to restore that authority.
ModelRuntime never owns currentModel.
```

In `src/coding-agent/README.md`, update the composition-root example:

```ts
const { runtime, modelConfig } = createModelRuntime();
const project = await createProject({
  keaHome,
  runtime,
  modelConfig,
});
```

Do not describe automatic title creation, AI stopping, compaction, steering, or follow-up as implemented.

- [ ] **Step 4: Search documentation and TypeScript for stale concepts**

Run:

```powershell
rg -n "createStreamFn|defaultModel|StreamFn|streamFn|shouldContinue\(\)|stopping.*返回一条消息|stopping.*only when" src tests -g "*.ts" -g "README.md"
```

Expected: no production or documentation matches. A test-local variable named `stream` or type named `TestStream` is allowed; the removed production name `StreamFn` is not.

Run:

```powershell
rg -n "titleGenerator|shouldStopAfterTurn" src/core src/coding-agent -g "*.ts" -g "README.md"
```

Expected: no new implementation references. If a README compares external designs, it must explicitly say the concept is not implemented; otherwise remove the reference.

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm run typecheck
npm test
git status --short
```

Expected:

- `npm run typecheck`: PASS with no diagnostics。
- `npm test`: PASS for the complete compiled test suite。
- `git status --short`: only the five README files and this task's intended documentation changes are uncommitted before the documentation commit。

- [ ] **Step 6: Review the final diff for scope and authority boundaries**

Run:

```powershell
git diff --check
git diff --stat
git diff -- src/core/ai src/core/agent src/core/harness src/coding-agent src/main.ts tests
```

Expected:

- no whitespace errors;
- no unrelated Session, Repository, Tool, UI, or provider Adapter rewrite;
- Runtime has no selected-model state;
- Harness has exactly one live `currentModel` field;
- Agent Loop never calls `runtime.complete()`;
- `agent/stopping` has exactly one boolean contract;
- no message-injection compatibility branch remains.

- [ ] **Step 7: Commit documentation and final alignment**

```powershell
git add src/core/ai/README.md src/core/agent/README.md src/core/events/README.md src/core/harness/README.md src/coding-agent/README.md
git commit -m "docs(core): explain model runtime boundary"
```

Expected: final documentation commit after all implementation and test commits pass.

---

## Final Acceptance Checklist

- [ ] `src/core/ai` publicly exposes `ModelRuntime` and `createModelRuntime()` but not `StreamFn` or `createStreamFn()`.
- [ ] `runtime.stream()` and `runtime.complete()` both require an explicit `ModelConfig`.
- [ ] `complete()` returns both successful and error terminal assistant messages and rejects a stream with no terminal chunk.
- [ ] Runtime has no current/default model field and no Session dependency.
- [ ] `runAgentLoop()` receives Runtime, binds only `runtime.stream`, and never calls `runtime.complete()`.
- [ ] `agent/stopping` receives the completed message, Tool Results, and current history, then returns `boolean`.
- [ ] The default stopping decision is `toolResults.length === 0`.
- [ ] `maxTurns` is a hard Agent Loop limit and cannot be overridden by an Event listener.
- [ ] `agent/stopping` no longer injects an `AgentMessage`.
- [ ] Harness config is exactly `runtime + modelConfig` for AI dependencies.
- [ ] Harness retains live `currentModel`; Session retains durable `model_selection` records.
- [ ] Project and application composition roots use `createModelRuntime()`.
- [ ] No title generation, compaction, AI stopping listener, steering, or follow-up implementation was added.
- [ ] All focused tests, typecheck, complete test suite, import smoke tests, and `git diff --check` pass.
