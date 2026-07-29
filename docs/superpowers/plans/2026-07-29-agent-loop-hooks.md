# Agent Loop Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kea's stringly, reducer-configured callbacks with typed Agent Loop control hooks, then compose five default Coding Agent hooks through an injected UI port.

**Architecture:** `HookRegistry` owns typed registration, observation, event-specific result combination, cancellation, and cleanup. `runAgentLoop()` depends only on `AgentHookTrigger`; `AgentHarness` passes that trigger through; `coding-agent` owns the concrete hook context, Bash policy, five defaults, and Factory assembly. CLI implements `CodingHookUI`, while `AgentEvent` / `subscribe` remain the independent observation channel.

**Tech Stack:** TypeScript 7, Node.js 24 ESM, Node test runner, TypeBox, readline/promises.

## Global Constraints

- Implement the approved spec at `docs/superpowers/specs/2026-07-29-agent-loop-hooks-design.md`.
- Preserve the pre-existing uncommitted changes in `docs/architecture.md`, `src/ai/adapters/anthropic.ts`, `src/ai/factory.ts`, deleted `src/ai/utils/event-stream.ts`, and `tests/ai/factory.test.ts`; do not reset, overwrite, stage, or commit them.
- Baseline before implementation is `npm run typecheck` PASS and `npm test` PASS with 99 tests.
- Implement only Agent Loop hooks: `user_prompt`, `context`, `tool_call`, `tool_result`, and `stop`.
- Do not add Harness-specific hook events, a second dispatcher, an ExtensionHost, EventBus, fixed Agent Loop callbacks, configurable reducers, or arbitrary custom-event support.
- `AgentEvent` / `AgentHarness.subscribe()` remain observation-only; Hook returns remain control-only.
- `context` transformations affect only the current LLM request and never overwrite Session or Harness history.
- The final `tool_result` must be identical in `tool_end`, history, and the next LLM request.
- Permission cannot authorize a workspace escape; existing file-tool safe-path checks remain authoritative.
- No UI and UI failures are fail-closed for commands classified as `ask`.
- `BashTool` keeps a hard-deny check even when no HookRegistry is installed.
- `agent` must not import `coding-agent` or CLI; `coding-agent` must not import CLI; CLI implements the coding-owned interface.
- Keep `CreateHarnessConfig` in `coding-agent`, not `agent/harness`, because it contains `CodingHookUI`.
- Use TDD for every behavior task and commit only the task's files.
- Use `apply_patch` for hand-written file changes.
- Use exact-path `git add` commands. For `docs/architecture.md`, do not stage its pre-existing whole-file rewrite; leave the hook documentation hunk uncommitted if it cannot be isolated safely.

---

## File Map

### Create

- `src/agent/hooks/index.ts` — complete Hook-related Agent package entry.
- `src/coding-agent/types.ts` — Coding factory config and public Hook UI/context contracts.
- `src/coding-agent/hooks/types.ts` — internal `CodingHookRegistry` alias and `NO_UI`.
- `src/coding-agent/hooks/context-inject.ts` — `user_prompt` teaching notification.
- `src/coding-agent/hooks/permission.ts` — `tool_call` permission gate.
- `src/coding-agent/hooks/log.ts` — filtered `tool_call` observer.
- `src/coding-agent/hooks/large-output.ts` — filtered `tool_result` observer.
- `src/coding-agent/hooks/summary.ts` — `stop` summary handler.
- `src/coding-agent/hooks/factory.ts` — default five-Hook registry assembly.
- `src/coding-agent/hooks/index.ts` — internal Hook module entry.
- `src/coding-agent/tools/bash-policy.ts` — single Bash allow/ask/deny policy source.
- `src/coding-agent/README.md` — Coding Agent usage, exports, defaults, UI port, and dependencies.
- `tests/coding-agent/hooks/permission.test.ts` — Bash classification and permission decisions.
- `tests/coding-agent/hooks/defaults.test.ts` — context/log/output/summary/default-registry behavior.
- `tests/cli/frontend.test.ts` — `CodingHookUI` confirmation and notification behavior.

### Rewrite

- `src/agent/hooks/types.ts` — typed event/result/handler/observer/trigger contracts.
- `src/agent/hooks/registry.ts` — typed event dispatcher, result combination, snapshots, cleanup, disposal.
- `tests/agent/hooks/registry.test.ts` — the complete Registry contract.

### Modify

- `src/agent/types.ts` — `AgentLoopConfig.hooks: AgentHookTrigger`.
- `src/agent/agent-loop.ts` — five Hook control points and approved error semantics.
- `src/agent/harness/types.ts` — narrow optional `AgentHookTrigger`; remove coding-owned config.
- `src/agent/harness/agent-harness.ts` — pass the trigger through and create a typed empty default.
- `src/agent/harness/index.ts` — retain only generic Harness exports.
- `src/coding-agent/tools/bash.ts` — consume only `hardDeniedBashReason`.
- `src/coding-agent/factory.ts` — assemble the default Coding HookRegistry.
- `src/coding-agent/index.ts` — export the approved Coding Hook API.
- `src/cli/frontend.ts` — implement `CodingHookUI`.
- `src/main.ts` — create CLI before Harness and inject it.
- `src/index.ts` — expose Agent Hook public entry.
- `tests/agent/agent-loop.test.ts` — all five Loop control points and failures.
- `tests/coding-agent/agent-harness.test.ts` — pass-through, history, idle restoration.
- `tests/coding-agent/factory.test.ts` — default Hook assembly and per-Harness isolation.
- `tests/coding-agent/tools/bash.test.ts` — hard-deny defense and ordinary-rm behavior.
- `tests/import-smoke.test.ts` — public Hook and Coding UI exports.
- `src/agent/README.md` — full Agent API and observation/control distinction.
- `src/agent/harness/README.md` — trigger pass-through and no Harness hooks.
- `docs/architecture.md` — current working-tree architecture plus the approved Hook data/control paths.
- `README.md` — remove stale LLM Client, AgentSession, PermissionHook, and tool descriptions.

---

### Task 1: Replace the reducer map with a typed, lifecycle-safe `HookRegistry`

**Files:**

- Rewrite: `src/agent/hooks/types.ts`
- Rewrite: `src/agent/hooks/registry.ts`
- Create: `src/agent/hooks/index.ts`
- Rewrite: `tests/agent/hooks/registry.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `AgentMessage` from `src/agent/types.ts`.
- Produces:

```ts
export interface HookEvent<TType extends string, TResult = void> {
  readonly type: TType;
  readonly [HookResult]?: TResult;
}

export type AgentHookEvent =
  | UserPromptEvent
  | ContextEvent
  | ToolCallEvent
  | ToolResultEvent
  | StopEvent;

export interface AgentHookTrigger {
  trigger<TEvent extends AgentHookEvent>(
    event: TEvent,
    signal?: AbortSignal,
  ): Promise<ResultOf<TEvent> | undefined>;
}

export class HookRegistry<
  TEvent extends HookEvent<string, unknown>,
  TContext,
> {
  constructor(context: TContext);
  get context(): TContext;
  setContext(context: TContext): void;
  register<TType extends TEvent["type"]>(
    type: TType,
    handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
  ): Unregister;
  registerObserver(observer: HookObserver<TEvent, TContext>): Unregister;
  trigger<T extends TEvent>(
    event: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined>;
  addCleanup(cleanup: Cleanup): Unregister;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}
```

- `HookResult` remains a module-private phantom symbol.
- Runtime event types outside the five-member `AgentHookEvent` union throw `Unknown hook event '<type>'`.

- [ ] **Step 1: Replace the old reducer tests with typed event-combination tests**

Import `AgentHookEvent`, `HookObserver`, and `Unregister` from `src/agent/hooks/types.ts` together with the new `HookRegistry`.

Write these concrete cases in `tests/agent/hooks/registry.test.ts` using:

```ts
type TestContext = { label: string };

function registry(
  context: TestContext = { label: "initial" },
): HookRegistry<AgentHookEvent, TestContext> {
  return new HookRegistry<AgentHookEvent, TestContext>(context);
}

test("user_prompt ignores block false and exits on block true", async () => {
  const hooks = registry();
  const calls: string[] = [];
  hooks.register("user_prompt", () => {
    calls.push("first");
    return { block: false, reason: "not a block" };
  });
  hooks.register("user_prompt", () => {
    calls.push("second");
    return { block: true, reason: "denied" };
  });
  hooks.register("user_prompt", () => {
    calls.push("third");
  });

  assert.deepEqual(
    await hooks.trigger({ type: "user_prompt", prompt: "hello" }),
    { block: true, reason: "denied" },
  );
  assert.deepEqual(calls, ["first", "second"]);
});

test("context handlers see the previous messages result", async () => {
  const hooks = registry();
  hooks.register("context", ({ messages }) => ({
    messages: [...messages, { role: "user", content: "first" }],
  }));
  hooks.register("context", ({ messages }) => ({
    messages: [...messages, { role: "user", content: "second" }],
  }));

  const result = await hooks.trigger({
    type: "context",
    messages: [{ role: "user", content: "original" }],
  });
  assert.deepEqual(
    result?.messages.map((message) =>
      message.role === "user" ? message.content : message.role
    ),
    ["original", "first", "second"],
  );
});

test("tool_call shares mutable input and exits only on block true", async () => {
  const hooks = registry();
  const input: Record<string, unknown> = { command: "pwd" };
  hooks.register("tool_call", (event) => {
    event.input.command = "echo changed";
    return { block: false };
  });
  hooks.register("tool_call", (event) => {
    assert.equal(event.input.command, "echo changed");
  });

  assert.equal(await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input,
  }), undefined);
  assert.equal(input.command, "echo changed");
});

test("tool_result handlers see and return the accumulated patch", async () => {
  const hooks = registry();
  hooks.register("tool_result", () => ({ content: "changed" }));
  hooks.register("tool_result", (event) => {
    assert.equal(event.content, "changed");
    return { isError: true };
  });

  assert.deepEqual(await hooks.trigger({
    type: "tool_result",
    toolCallId: "c1",
    toolName: "bash",
    input: {},
    content: "raw",
    isError: false,
  }), { content: "changed", isError: true });
});

test("stop uses the first continueWith result", async () => {
  const hooks = registry();
  hooks.register("stop", () => ({
    continueWith: { role: "user", content: "continue" },
  }));
  hooks.register("stop", () => ({
    continueWith: { role: "user", content: "ignored" },
  }));

  assert.deepEqual(
    await hooks.trigger({ type: "stop", messages: [] }),
    { continueWith: { role: "user", content: "continue" } },
  );
});
```

- [ ] **Step 2: Add Observer, snapshot, signal, and error tests**

Append exact tests that assert:

```ts
test("observers run before handlers and cannot control the result", async () => {
  const hooks = registry();
  const calls: string[] = [];
  const unsafeObserver = ((
    _event: AgentHookEvent,
    context: TestContext,
    signal?: AbortSignal,
  ) => {
    calls.push(`observer:${context.label}:${String(signal?.aborted)}`);
    return { block: true };
  }) as unknown as HookObserver<AgentHookEvent, TestContext>;
  hooks.registerObserver(unsafeObserver);
  hooks.register("tool_call", () => {
    calls.push("handler");
  });
  const controller = new AbortController();

  assert.equal(await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: {},
  }, controller.signal), undefined);
  assert.deepEqual(calls, ["observer:initial:false", "handler"]);
});

test("trigger snapshots observers handlers and context", async () => {
  const hooks = registry();
  const calls: string[] = [];
  let removeSecond: Unregister = () => undefined;
  hooks.registerObserver((_event, context) => {
    calls.push(`observer:${context.label}`);
    hooks.setContext({ label: "next" });
    removeSecond();
    hooks.register("user_prompt", () => {
      calls.push("late");
    });
  });
  hooks.register("user_prompt", (_event, context) => {
    calls.push(`first:${context.label}`);
  });
  removeSecond = hooks.register("user_prompt", (_event, context) => {
    calls.push(`second:${context.label}`);
  });

  await hooks.trigger({ type: "user_prompt", prompt: "one" });
  await hooks.trigger({ type: "user_prompt", prompt: "two" });
  assert.deepEqual(calls, [
    "observer:initial", "first:initial", "second:initial",
    "observer:next", "first:next", "late",
  ]);
});

test("handler and observer errors propagate by identity", async () => {
  const handlerFailure = new Error("handler failed");
  const handlerHooks = registry();
  handlerHooks.register("stop", () => { throw handlerFailure; });
  await assert.rejects(
    handlerHooks.trigger({ type: "stop", messages: [] }),
    (error) => error === handlerFailure,
  );

  const observerFailure = new Error("observer failed");
  const observerHooks = registry();
  observerHooks.registerObserver(() => { throw observerFailure; });
  await assert.rejects(
    observerHooks.trigger({ type: "stop", messages: [] }),
    (error) => error === observerFailure,
  );
});
```

Also make both Handler and Observer capture the exact `AbortSignal` object and assert strict identity.

- [ ] **Step 3: Add unregister, cleanup, clear, and dispose tests**

Use idempotent unregister calls and the following lifecycle assertions:

```ts
test("clear removes registrations, runs every cleanup in reverse, and is reusable", async () => {
  const hooks = registry();
  const calls: string[] = [];
  const unregister = hooks.register("user_prompt", () => {
    calls.push("handler");
  });
  unregister();
  unregister();
  hooks.addCleanup(() => { calls.push("cleanup-1"); });
  hooks.addCleanup(async () => { calls.push("cleanup-2"); });

  await hooks.clear();
  await hooks.trigger({ type: "user_prompt", prompt: "ignored" });
  assert.deepEqual(calls, ["cleanup-2", "cleanup-1"]);

  hooks.register("user_prompt", () => { calls.push("reused"); });
  await hooks.trigger({ type: "user_prompt", prompt: "again" });
  assert.deepEqual(calls, ["cleanup-2", "cleanup-1", "reused"]);
});

test("handler observer and cleanup unregister functions are idempotent", async () => {
  const hooks = registry();
  const calls: string[] = [];
  const removeHandler = hooks.register("user_prompt", () => {
    calls.push("handler");
  });
  const removeObserver = hooks.registerObserver(() => {
    calls.push("observer");
  });
  const removeCleanup = hooks.addCleanup(() => {
    calls.push("cleanup");
  });

  removeHandler();
  removeHandler();
  removeObserver();
  removeObserver();
  removeCleanup();
  removeCleanup();
  await hooks.trigger({ type: "user_prompt", prompt: "ignored" });
  await hooks.clear();
  assert.deepEqual(calls, []);
});

test("clear runs all failing cleanups and aggregates multiple failures", async () => {
  const hooks = registry();
  const first = new Error("first");
  const second = new Error("second");
  const calls: string[] = [];
  hooks.addCleanup(() => { calls.push("first"); throw first; });
  hooks.addCleanup(() => { calls.push("second"); throw second; });

  await assert.rejects(
    hooks.clear(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === second &&
      error.errors[1] === first,
  );
  assert.deepEqual(calls, ["second", "first"]);
});

test("dispose is idempotent and permanently rejects operations", async () => {
  const hooks = registry();
  await hooks.dispose();
  await hooks.dispose();

  assert.throws(() => hooks.register("stop", () => undefined), /disposed/);
  assert.throws(() => hooks.registerObserver(() => undefined), /disposed/);
  assert.throws(() => hooks.addCleanup(() => undefined), /disposed/);
  assert.throws(() => hooks.setContext({ label: "next" }), /disposed/);
  await assert.rejects(
    hooks.trigger({ type: "stop", messages: [] }),
    /disposed/,
  );
});
```

Add these two tests:

```ts
test("clear rethrows one cleanup error by identity", async () => {
  const hooks = registry();
  const failure = new Error("cleanup failed");
  hooks.addCleanup(() => { throw failure; });
  await assert.rejects(hooks.clear(), (error) => error === failure);
});

test("runtime rejects event types outside AgentHookEvent", async () => {
  const hooks = registry();
  await assert.rejects(
    hooks.trigger(
      { type: "custom" } as unknown as AgentHookEvent,
    ),
    /Unknown hook event 'custom'/,
  );
});
```

- [ ] **Step 4: Run the Registry test build and verify the old implementation fails**

Run:

```bash
npm run build
```

Expected: FAIL because the old `HookRegistry` has no context, observer, event-object trigger, cleanup, or typed event API.

- [ ] **Step 5: Define the complete typed contracts**

Rewrite `src/agent/hooks/types.ts` with the spec's phantom-result base, the five concrete event/result interfaces, `AgentHookEvent`, `ResultOf`, `HookHandler`, `HookObserver`, `Cleanup`, `Unregister`, and `AgentHookTrigger`.

Use these exact event fields:

```ts
export interface UserPromptEvent
  extends HookEvent<"user_prompt", UserPromptResult> {
  readonly type: "user_prompt";
  readonly prompt: string;
}

export interface ContextEvent
  extends HookEvent<"context", ContextResult> {
  readonly type: "context";
  readonly messages: AgentMessage[];
}

export interface ToolCallEvent
  extends HookEvent<"tool_call", ToolCallResult> {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent
  extends HookEvent<"tool_result", ToolResultPatch> {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: string;
  readonly isError: boolean;
}

export interface StopEvent extends HookEvent<"stop", StopResult> {
  readonly type: "stop";
  readonly messages: readonly AgentMessage[];
}
```

- [ ] **Step 6: Implement the Registry without public reducers**

Rewrite `src/agent/hooks/registry.ts`. Store handlers by event type, observers in a `Set`, cleanups in registration order, and context in a mutable field. At `trigger()` entry:

```ts
this.assertActive();
this.assertKnownEvent(event.type);
const context = this._context;
const observers = [...this.observers];
const handlers = [...(this.handlers.get(event.type) ?? [])];

for (const observer of observers) {
  await observer(event, context, signal);
}
```

Then switch on the five known event types. Implement:

- `user_prompt`: ignore every result except `block === true`;
- `context`: rebuild the event with each returned `messages`;
- `tool_call`: share `event.input`, ignore `block: false`, early-exit on true;
- `tool_result`: rebuild the event with accumulated `content` / `isError`;
- `stop`: early-exit only on a defined `continueWith`.

For unregister functions, use an `active` boolean so repeated calls are no-ops. For cleanup:

```ts
private async clearRegistrations(): Promise<void> {
  const cleanups = [...this.cleanups].reverse();
  this.handlers.clear();
  this.observers.clear();
  this.cleanups.length = 0;
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Hook cleanup failed");
}
```

Mark disposed before disposal cleanup starts so a failed cleanup cannot leave a reusable registry.

- [ ] **Step 7: Add the public Hook entry**

Create `src/agent/hooks/index.ts` exporting `HookRegistry` plus every approved type:

```ts
export { HookRegistry } from "./registry.js";
export type {
  AgentHookEvent,
  AgentHookTrigger,
  Cleanup,
  ContextEvent,
  ContextResult,
  HookEvent,
  HookHandler,
  HookObserver,
  ResultOf,
  StopEvent,
  StopResult,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultPatch,
  Unregister,
  UserPromptEvent,
  UserPromptResult,
} from "./types.js";
```

Add `export * from "./agent/hooks/index.js";` to `src/index.ts`.

- [ ] **Step 8: Run focused and full verification**

Run:

```bash
npm run build
node --test dist/tests/agent/hooks/registry.test.js
npm run typecheck
```

Expected: all Registry tests PASS and typecheck PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/agent/hooks/types.ts src/agent/hooks/registry.ts src/agent/hooks/index.ts src/index.ts tests/agent/hooks/registry.test.ts
git commit -m "feat: add typed agent hook registry"
```

---

### Task 2: Add request-only context and natural-stop control to Agent Loop

**Files:**

- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `tests/agent/agent-loop.test.ts`

**Interfaces:**

- Consumes: `AgentHookTrigger`, `UserPromptEvent`, `ContextEvent`, and `StopEvent` from Task 1.
- Produces:

```ts
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  readonly hooks: AgentHookTrigger;
}
```

- [ ] **Step 1: Update the test helper to use a typed empty Registry**

In `tests/agent/agent-loop.test.ts`, replace `new HookRegistry()` with:

```ts
function emptyHooks(): HookRegistry<AgentHookEvent, Record<string, never>> {
  return new HookRegistry<AgentHookEvent, Record<string, never>>({});
}
```

Make `makeConfig()` use `hooks: emptyHooks()`.

- [ ] **Step 2: Add user prompt and request-only context tests**

Add:

```ts
test("user_prompt block prevents history and model access", async () => {
  const hooks = emptyHooks();
  hooks.register("user_prompt", () => ({
    block: true,
    reason: "blocked",
  }));
  let streams = 0;
  const history: AgentMessage[] = [];
  const events = await collect(runAgentLoop(
    "secret",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ hooks }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg("unused") };
    },
  ));

  assert.equal(streams, 0);
  assert.deepEqual(history, []);
  assert.deepEqual(events, [
    { type: "agent_start" },
    { type: "agent_end", messages: [] },
  ]);
});

test("context hook changes one request without replacing real history", async () => {
  const hooks = emptyHooks();
  hooks.register("context", ({ messages }) => ({
    messages: [
      ...messages,
      { role: "user", content: "request-only" },
    ],
  }));
  const history: AgentMessage[] = [];
  let requestMessages: readonly Message[] = [];
  await collect(runAgentLoop(
    "real",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ hooks }),
    async function* (_model, context) {
      requestMessages = [...context.messages];
      yield { type: "done", message: assistantMsg("done") };
    },
  ));

  assert.deepEqual(
    requestMessages.map((message) =>
      message.role === "user" ? message.content : message.role
    ),
    ["real", "request-only"],
  );
  assert.deepEqual(
    history.map((message) =>
      message.role === "user" ? message.content : message.role
    ),
    ["real", "assistant"],
  );
});
```

- [ ] **Step 3: Add stop continuation and no-stop-on-error/abort tests**

Use two model streams and assert:

```ts
test("stop continueWith appends a message and starts another turn", async () => {
  const hooks = emptyHooks();
  let stops = 0;
  hooks.register("stop", () => {
    stops++;
    return stops === 1
      ? { continueWith: { role: "user", content: "continue" } }
      : undefined;
  });
  const history: AgentMessage[] = [];
  let streams = 0;
  await collect(runAgentLoop(
    "start",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ hooks }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg(`answer-${streams}`) };
    },
  ));

  assert.equal(streams, 2);
  assert.equal(stops, 2);
  assert.deepEqual(history.map((message) => message.role), [
    "user", "assistant", "user", "assistant",
  ]);
  assert.equal(history[2]?.role === "user" ? history[2].content : "", "continue");
});
```

Add:

```ts
test("AI error does not trigger stop", async () => {
  const hooks = emptyHooks();
  let stops = 0;
  hooks.register("stop", () => { stops++; });
  const failed = {
    ...assistantMsg(""),
    stopReason: "error" as const,
    errorMessage: "provider failed",
  };

  await collect(runAgentLoop(
    "start",
    {
      systemPrompt: "",
      messages: [],
      tools: new AgentToolRegistry(),
    },
    makeConfig({ hooks }),
    streamFnWithEvents([[{ type: "error", message: failed }]]),
  ));
  assert.equal(stops, 0);
});

test("pre-aborted run does not trigger stop", async () => {
  const hooks = emptyHooks();
  let stops = 0;
  hooks.register("stop", () => { stops++; });
  const controller = new AbortController();
  controller.abort();

  await collect(runAgentLoop(
    "start",
    {
      systemPrompt: "",
      messages: [],
      tools: new AgentToolRegistry(),
    },
    makeConfig({ hooks }),
    streamFnWithEvents([]),
    controller.signal,
  ));
  assert.equal(stops, 0);
});
```

- [ ] **Step 4: Verify the new tests fail**

Run:

```bash
npm run build
```

Expected: FAIL because Agent Loop still uses `trigger(type, event)`, mutates real history for `context`, and has no `stop`.

- [ ] **Step 5: Change `AgentLoopConfig` to the narrow trigger**

In `src/agent/types.ts`, remove the `HookRegistry` import, import `AgentHookTrigger` as a type, and set:

```ts
readonly hooks: AgentHookTrigger;
```

Do not add registration, context, cleanup, or UI to `AgentLoopConfig`.

- [ ] **Step 6: Implement user, context, and stop control points**

In `runAgentLoop()`:

```ts
const userPromptResult = await config.hooks.trigger(
  { type: "user_prompt", prompt: input },
  signal,
);
if (userPromptResult?.block === true) {
  yield { type: "agent_end", messages: [...context.messages] };
  return;
}
```

Delete the `pre_turn` and `turn_end` Hook calls.

For each model request:

```ts
const requestMessages = [...context.messages];
const contextResult = await config.hooks.trigger(
  { type: "context", messages: requestMessages },
  signal,
);
const llmMessages = config.convertToLlm(
  contextResult?.messages ?? requestMessages,
);
```

For a normal assistant response without tool calls:

```ts
const stopResult = await config.hooks.trigger(
  { type: "stop", messages: [...context.messages] },
  signal,
);
if (stopResult?.continueWith !== undefined) {
  context.messages.push(stopResult.continueWith);
  continue;
}
yield { type: "agent_end", messages: [...context.messages] };
return;
```

Keep AI error and Abort exits before this block so neither triggers `stop`.

- [ ] **Step 7: Run focused verification**

```bash
npm run build
node --test dist/tests/agent/agent-loop.test.js
npm run typecheck
```

Expected: all Agent Loop tests through the new prompt/context/stop cases PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/agent/types.ts src/agent/agent-loop.ts tests/agent/agent-loop.test.ts
git commit -m "feat: add prompt context and stop hooks"
```

---

### Task 3: Make tool hooks control validated input and the final stored result

**Files:**

- Modify: `src/agent/agent-loop.ts`
- Modify: `tests/agent/agent-loop.test.ts`

**Interfaces:**

- Consumes: `ToolCallEvent`, `ToolCallResult`, `ToolResultEvent`, and `ToolResultPatch` from Task 1.
- Produces: one final `AgentToolResult` used for `tool_end`, history, and the next LLM request.

- [ ] **Step 1: Add tool input mutation and final validation tests**

Update the test imports to include `type Static` from `typebox`, `type AgentToolCall` from `agent/tools/types.ts`, and `type AgentHookEvent` from `agent/hooks/types.ts`.

Add this shared test class:

```ts
const typedParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

class TypedTool extends AgentTool<typeof typedParameters> {
  ran = false;
  seen = "";
  constructor() {
    super("typed", "Typed tool.", typedParameters);
  }
  async execute(
    arguments_: Static<typeof typedParameters>,
  ): Promise<AgentToolResult> {
    this.ran = true;
    this.seen = arguments_.value;
    return { content: arguments_.value, isError: false };
  }
}

class NoopTool extends AgentTool<typeof emptyParameters> {
  ran = false;
  constructor() {
    super("noop", "No-op tool.", emptyParameters);
  }
  async execute(): Promise<AgentToolResult> {
    this.ran = true;
    return { content: "raw", isError: false };
  }
}

function streamForToolCall(call: AgentToolCall): StreamFn {
  return streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ]);
}

test("tool_call can repair input before final TypeBox validation", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "typed",
    arguments: { value: 1 },
  };
  const hooks = emptyHooks();
  hooks.register("tool_call", (event) => {
    event.input.value = "fixed";
  });

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ hooks }),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, true);
  assert.equal(tool.seen, "fixed");
});

test("tool_call mutation cannot bypass final TypeBox validation", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "typed",
    arguments: { value: "valid" },
  };
  const hooks = emptyHooks();
  hooks.register("tool_call", (event) => {
    event.input.value = 1;
  });

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ hooks }),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, false);
  const toolMessage = history.find((message) => message.role === "tool");
  assert.match(
    toolMessage?.role === "tool" ? toolMessage.content : "",
    /Invalid arguments for tool 'typed'/,
  );
});
```

Use real `AgentToolRegistry.execute()` so TypeBox remains the final validator.

- [ ] **Step 2: Add tool block semantics and Observer visibility tests**

Add:

```ts
test("tool_call block false continues and block true creates an error result", async () => {
  class ObservedTool extends AgentTool<typeof emptyParameters> {
    ran = false;
    constructor() {
      super("noop", "No-op tool.", emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      this.ran = true;
      return { content: "ran", isError: false };
    }
  }
  const tool = new ObservedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "noop",
    arguments: {},
  };
  const hooks = emptyHooks();
  const calls: string[] = [];
  hooks.registerObserver((event) => {
    if (event.type === "tool_call") calls.push("observed");
  });
  hooks.register("tool_call", () => ({ block: false, reason: "ignored" }));
  hooks.register("tool_call", () => ({ block: true, reason: "denied" }));

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ hooks }),
    streamForToolCall(call),
  ));
  const toolMessage = history.find((message) => message.role === "tool");
  assert.deepEqual(calls, ["observed"]);
  assert.equal(tool.ran, false);
  assert.equal(
    toolMessage?.role === "tool" ? toolMessage.content : "",
    "Error: denied",
  );
});
```

- [ ] **Step 3: Add final `tool_result` consistency tests**

```ts
test("tool_result patch is identical in event history and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "noop",
    arguments: {},
  };
  const hooks = emptyHooks();
  hooks.register("tool_result", () => ({
    content: "patched",
    isError: true,
  }));
  let secondRequest: readonly Message[] = [];
  const stream = streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ], (context, index) => {
    if (index === 1) secondRequest = [...context.messages];
  });

  const events = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ hooks }),
    stream,
  ));
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.deepEqual(toolEnd.result, {
    content: "patched",
    isError: true,
  });
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "patched",
    isError: true,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});
```

- [ ] **Step 4: Add Hook failure and signal tests**

```ts
test("tool_call Hook failure blocks execution", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const hooks = emptyHooks();
  hooks.register("tool_call", () => {
    throw new Error("permission crashed");
  });

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ hooks }),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, false);
  assert.equal(
    history[2]?.role === "tool" ? history[2].content : "",
    "Error: tool_call hook failed: permission crashed",
  );
});

test("tool_result Hook failure replaces event history and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const hooks = emptyHooks();
  hooks.register("tool_result", () => {
    throw new Error("post hook crashed");
  });
  let secondRequest: readonly Message[] = [];
  const stream = streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ], (context, index) => {
    if (index === 1) secondRequest = [...context.messages];
  });

  const events = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ hooks }),
    stream,
  ));
  const expected = {
    content: "Error: tool_result hook failed: post hook crashed",
    isError: true,
  };
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.deepEqual(toolEnd.result, expected);
  assert.equal(history[2]?.role, "tool");
  if (history[2]?.role !== "tool") return;
  assert.deepEqual(
    { content: history[2].content, isError: history[2].isError },
    expected,
  );
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("Agent run signal reaches every Hook trigger", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const hooks = emptyHooks();
  const seen: Array<{ type: string; signal: AbortSignal | undefined }> = [];
  hooks.registerObserver((event, _context, signal) => {
    seen.push({ type: event.type, signal });
  });
  const controller = new AbortController();

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ hooks }),
    streamForToolCall(call),
    controller.signal,
  ));
  assert.deepEqual(seen.map(({ type }) => type), [
    "user_prompt",
    "context",
    "tool_call",
    "tool_result",
    "context",
    "stop",
  ]);
  assert.ok(seen.every(({ signal }) => signal === controller.signal));
});
```

- [ ] **Step 5: Verify the tests fail**

Run:

```bash
npm run build
```

Expected: FAIL because the old Loop uses the old trigger signature, stores/yields before `tool_result`, and drops its patch.

- [ ] **Step 6: Implement tool Hook control and error normalization**

Create a local helper:

```ts
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

For each tool call:

1. Yield `tool_start`.
2. Trigger `tool_call` with `input: call.arguments` and the run signal.
3. Catch a trigger exception and set block reason to `tool_call hook failed: <message>`.
4. Execute the same mutated `call` only if not blocked/aborted.
5. Trigger `tool_result` before history or `tool_end`.
6. Apply returned `content` and `isError`.
7. Catch `tool_result` errors and replace the whole result with the exact error shape from Step 4.
8. Push the final tool message.
9. Yield `tool_end` with the same final result.

Use:

```ts
const patch = await config.hooks.trigger({
  type: "tool_result",
  toolCallId: call.id,
  toolName: call.name,
  input: call.arguments,
  content: result.content,
  isError: result.isError,
}, signal);

if (patch !== undefined) {
  result = {
    content: patch.content ?? result.content,
    isError: patch.isError ?? result.isError,
  };
}
```

- [ ] **Step 7: Run focused verification**

```bash
npm run build
node --test dist/tests/agent/agent-loop.test.js
npm run typecheck
```

Expected: Agent Loop tests PASS, including TypeBox validation after mutation and three-location result consistency.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/agent/agent-loop.ts tests/agent/agent-loop.test.ts
git commit -m "feat: integrate tool control hooks"
```

---

### Task 4: Make Harness a narrow Hook trigger pass-through

**Files:**

- Modify: `src/agent/harness/types.ts`
- Modify: `src/agent/harness/agent-harness.ts`
- Modify: `src/agent/harness/index.ts`
- Modify: `tests/coding-agent/agent-harness.test.ts`

**Interfaces:**

- Consumes: `AgentHookTrigger`, `AgentHookEvent`, and `HookRegistry` from Tasks 1–3.
- Produces:

```ts
export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
  readonly hooks?: AgentHookTrigger;
}
```

- `CreateHarnessConfig` is removed from `agent/harness/types.ts`; Task 7 recreates it in `coding-agent/types.ts`.

- [ ] **Step 1: Add Harness Hook pass-through and idle-restoration tests**

Extend the local Harness test factory with `hooks?: AgentHookTrigger`. Add:

```ts
test("Harness passes one Hook trigger to Agent Loop", async () => {
  const hooks = new HookRegistry<AgentHookEvent, { calls: string[] }>({
    calls: [],
  });
  hooks.register("user_prompt", (_event, context) => {
    context.calls.push("user_prompt");
  });
  hooks.register("context", (_event, context) => {
    context.calls.push("context");
  });
  hooks.register("stop", (_event, context) => {
    context.calls.push("stop");
  });

  const harness = createHarness({ hooks });
  await harness.prompt("hello");
  assert.deepEqual(hooks.context.calls, [
    "user_prompt", "context", "stop",
  ]);
});

test("user_prompt and context Hook failures reject prompt and restore idle", async () => {
  for (const type of ["user_prompt", "context"] as const) {
    const hooks = new HookRegistry<AgentHookEvent, Record<string, never>>({});
    hooks.register(type, () => { throw new Error(`${type} failed`); });
    const harness = createHarness({ hooks });

    await assert.rejects(harness.prompt("hello"), new RegExp(`${type} failed`));
    assert.equal(harness.isRunning, false);
  }
});

test("stop Hook failure keeps the completed assistant message and restores idle", async () => {
  const hooks = new HookRegistry<AgentHookEvent, Record<string, never>>({});
  hooks.register("stop", () => { throw new Error("stop failed"); });
  const harness = createHarness({ hooks });

  await assert.rejects(harness.prompt("hello"), /stop failed/);
  assert.equal(harness.messages.at(-1)?.role, "assistant");
  assert.equal(harness.isRunning, false);
});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
npm run build
```

Expected: FAIL while Harness still requires a concrete old Registry and constructs it without context.

- [ ] **Step 3: Narrow Harness types and default trigger**

In `agent-harness.ts`, use:

```ts
private readonly hooks: AgentHookTrigger;

this.hooks = config.hooks ??
  new HookRegistry<AgentHookEvent, Record<string, never>>({});
```

Keep `createLoopConfig()` as a pure pass-through. Remove `CreateHarnessConfig` from generic Harness types and ensure `src/agent/harness/index.ts` exports only generic Harness, Session, and prompt-builder contracts.

- [ ] **Step 4: Run Harness verification**

```bash
npm run build
node --test dist/tests/coding-agent/agent-harness.test.js
npm run typecheck
```

Expected: Harness tests PASS; no `coding-agent` or CLI import appears under `src/agent/`.

- [ ] **Step 5: Verify the import boundary**

Run:

```bash
rg -n "coding-agent|src/cli|\\.\\./\\.\\./cli" src/agent
```

Expected: no source import matches.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/agent/harness/types.ts src/agent/harness/agent-harness.ts src/agent/harness/index.ts tests/coding-agent/agent-harness.test.ts
git commit -m "refactor: pass hooks through agent harness"
```

---

### Task 5: Centralize Bash policy and implement fail-closed Permission Hook

**Files:**

- Create: `src/coding-agent/types.ts`
- Create: `src/coding-agent/hooks/types.ts`
- Create: `src/coding-agent/hooks/permission.ts`
- Create: `src/coding-agent/tools/bash-policy.ts`
- Create: `tests/coding-agent/hooks/permission.test.ts`
- Modify: `src/coding-agent/tools/bash.ts`
- Modify: `tests/coding-agent/tools/bash.test.ts`

**Interfaces:**

- Consumes: `HookRegistry<AgentHookEvent, CodingHookContext>` from Task 1.
- Produces:

```ts
export interface PermissionRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export interface HookNotification {
  readonly source:
    | "context_inject"
    | "tool_log"
    | "large_output"
    | "summary";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface CodingHookUI {
  readonly available: boolean;
  confirm(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}

export interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}

export function hardDeniedBashReason(command: string): string | undefined;

export function classifyBashCommand(command: string):
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };

export function registerPermissionHook(
  registry: CodingHookRegistry,
): void;
```

- [ ] **Step 1: Add exact Bash classification tests**

In `tests/coding-agent/hooks/permission.test.ts`:

```ts
test("Bash policy hard-denies commands that must never reach UI", () => {
  for (const command of [
    "sudo true",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /dev/sda",
    "rm -rf /",
    "rm -r -f /",
  ]) {
    assert.equal(classifyBashCommand(command).decision, "deny", command);
    assert.ok(hardDeniedBashReason(command), command);
  }
});

test("Bash policy asks only for the teaching risk rules", () => {
  for (const command of [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]) {
    assert.equal(classifyBashCommand(command).decision, "ask", command);
    assert.equal(hardDeniedBashReason(command), undefined, command);
  }
});

test("Bash policy allows ordinary commands", () => {
  for (const command of ["pwd", "npm test", "git status"]) {
    assert.deepEqual(classifyBashCommand(command), { decision: "allow" });
  }
});
```

The policy is intentionally a transparent teaching policy, not a claim of complete shell parsing.

- [ ] **Step 2: Add Permission Hook allow/ask/deny tests**

Add these helpers before the tests:

```ts
class RecordingUI implements CodingHookUI {
  readonly requests: PermissionRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(
    readonly available: boolean,
    private readonly answer: boolean | Error,
  ) {}

  async confirm(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.requests.push(request);
    this.signals.push(signal);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }

  notify(): void {}
}

function codingHooks(ui: CodingHookUI): CodingHookRegistry {
  return new HookRegistry<AgentHookEvent, CodingHookContext>({
    cwd: process.cwd(),
    ui,
  });
}

function triggerBash(
  hooks: CodingHookRegistry,
  command: string,
  signal?: AbortSignal,
) {
  return hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command },
  }, signal);
}

test("permission hard-deny never asks UI", async () => {
  const ui = new RecordingUI(true, true);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);

  const result = await triggerBash(hooks, "sudo true");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /sudo/);
  assert.deepEqual(ui.requests, []);
});

test("permission asks for rm and accepts explicit approval", async () => {
  const ui = new RecordingUI(true, true);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);

  assert.equal(await triggerBash(hooks, "rm file.txt"), undefined);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0]?.toolName, "bash");
});

test("permission fails closed without UI, on decline, and on UI error", async () => {
  const cases = [
    new RecordingUI(false, true),
    new RecordingUI(true, false),
    new RecordingUI(true, new Error("ui failed")),
  ];
  for (const ui of cases) {
    const hooks = codingHooks(ui);
    registerPermissionHook(hooks);
    const result = await triggerBash(hooks, "rm file.txt");
    assert.equal(result?.block, true);
  }
});

test("permission ignores non-bash tools and safe Bash commands", async () => {
  const ui = new RecordingUI(true, false);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);
  assert.equal(await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "write_file",
    input: { path: "inside.txt", content: "ok" },
  }), undefined);
  assert.equal(await triggerBash(hooks, "pwd"), undefined);
  assert.deepEqual(ui.requests, []);
});

test("permission forwards the run signal to UI", async () => {
  const ui = new RecordingUI(true, true);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);
  const controller = new AbortController();

  await triggerBash(hooks, "rm file.txt", controller.signal);
  assert.equal(ui.signals[0], controller.signal);
});
```

- [ ] **Step 3: Change the BashTool defense tests**

Replace the old “complete policy” test with:

```ts
test("bash tool independently blocks only hard-denied commands", async () => {
  const ops = new RecordingBashOperations();
  const tool = new BashTool(process.cwd(), ops);
  for (const command of [
    "rm -rf /",
    "sudo true",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /dev/sda",
  ]) {
    const result = await tool.execute({ command }, signal());
    assert.equal(result.isError, true, command);
    assert.match(result.content, /Permission denied/, command);
  }
  assert.deepEqual(ops.calls, []);
});

test("bash tool leaves ask-class commands to the Hook layer", async () => {
  const ops = new RecordingBashOperations();
  const tool = new BashTool(process.cwd(), ops);
  for (const command of [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]) {
    assert.equal((await tool.execute({ command }, signal())).isError, false);
  }
  assert.deepEqual(ops.calls, [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]);
});
```

- [ ] **Step 4: Verify tests fail**

Run:

```bash
npm run build
```

Expected: FAIL because the policy/context/Permission modules do not exist and BashTool still hard-blocks ordinary `rm`.

- [ ] **Step 5: Define Coding UI/context and internal registry types**

Create `src/coding-agent/types.ts` with the spec's `PermissionRequest`, `HookNotification`, `CodingHookUI`, and `CodingHookContext`.

Create `src/coding-agent/hooks/types.ts`:

```ts
import { HookRegistry } from "../../agent/hooks/registry.js";
import type { AgentHookEvent } from "../../agent/hooks/types.js";
import type { CodingHookContext, CodingHookUI } from "../types.js";

export type CodingHookRegistry =
  HookRegistry<AgentHookEvent, CodingHookContext>;

export const NO_UI: CodingHookUI = Object.freeze({
  available: false,
  async confirm() {
    return false;
  },
  notify() {
    return undefined;
  },
});
```

`NO_UI` is imported internally but never re-exported from `src/coding-agent/index.ts`.

- [ ] **Step 6: Implement the single Bash policy source**

Create `bash-policy.ts` with an ordered hard-deny rule list and ask rule list. Match the exact Step 1 cases. Return stable reasons such as:

```ts
const HARD_DENY_RULES = [
  { pattern: /\bsudo\b/i, reason: "sudo is not allowed" },
  { pattern: /\b(?:shutdown|reboot)\b/i, reason: "system shutdown is not allowed" },
  { pattern: /\bmkfs(?:\.[\w-]+)?\b/i, reason: "filesystem formatting is not allowed" },
  { pattern: /\bdd\b[^;&|]*\bif\s*=/i, reason: "raw dd input is not allowed" },
  { pattern: /(?:^|[;&|])[^;&|]*(?:>|>>)\s*\/dev(?:\/|$)/i, reason: "device redirection is not allowed" },
] as const;
```

Implement recursive forced root deletion as a named helper so combined (`-rf`) and split (`-r -f`) flags are both tested. Evaluate hard deny before ask. Ask reasons are:

- `rm` → `file deletion requires approval`;
- redirect to `/etc/` → `system configuration write requires approval`;
- `chmod 777` → `world-writable permissions require approval`.

- [ ] **Step 7: Implement Permission registration and BashTool defense**

`registerPermissionHook()` handles only `toolName === "bash"` and string `input.command`. For `ask`:

```ts
if (!context.ui.available) {
  return { block: true, reason: `${decision.reason}; no confirmation UI available` };
}
try {
  const allowed = await context.ui.confirm({
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    reason: decision.reason,
  }, signal);
  return allowed
    ? undefined
    : { block: true, reason: "permission denied by user" };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  return { block: true, reason: `permission confirmation failed: ${message}` };
}
```

In `BashTool.execute()`, replace its local fragment list with `hardDeniedBashReason(command)`.

- [ ] **Step 8: Run focused verification**

```bash
npm run build
node --test dist/tests/coding-agent/hooks/permission.test.js
node --test dist/tests/coding-agent/tools/bash.test.js
npm run typecheck
```

Expected: policy, Permission, and Bash defense tests PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/coding-agent/types.ts src/coding-agent/hooks/types.ts src/coding-agent/hooks/permission.ts src/coding-agent/tools/bash-policy.ts src/coding-agent/tools/bash.ts tests/coding-agent/hooks/permission.test.ts tests/coding-agent/tools/bash.test.ts
git commit -m "feat: add coding agent permission hook"
```

---

### Task 6: Implement the four observational/default hooks and Coding registry factory

**Files:**

- Create: `src/coding-agent/hooks/context-inject.ts`
- Create: `src/coding-agent/hooks/log.ts`
- Create: `src/coding-agent/hooks/large-output.ts`
- Create: `src/coding-agent/hooks/summary.ts`
- Create: `src/coding-agent/hooks/factory.ts`
- Create: `src/coding-agent/hooks/index.ts`
- Create: `tests/coding-agent/hooks/defaults.test.ts`

**Interfaces:**

- Consumes: `CodingHookRegistry`, `CodingHookContext`, and `registerPermissionHook`.
- Produces:

```ts
export function createCodingHookRegistry(
  context: CodingHookContext,
): HookRegistry<AgentHookEvent, CodingHookContext>;
```

- [ ] **Step 1: Add exact notification tests**

Add these helpers:

```ts
class NotificationUI implements CodingHookUI {
  readonly available = false;
  readonly notifications: HookNotification[] = [];

  async confirm(): Promise<boolean> {
    return false;
  }

  notify(notification: HookNotification): void {
    this.notifications.push(notification);
  }
}

function setup(
  register: (hooks: CodingHookRegistry) => void,
): {
  hooks: CodingHookRegistry;
  notifications: HookNotification[];
} {
  const ui = new NotificationUI();
  const hooks = new HookRegistry<AgentHookEvent, CodingHookContext>({
    cwd: process.cwd(),
    ui,
  });
  register(hooks);
  return { hooks, notifications: ui.notifications };
}

function triggerToolResult(
  hooks: CodingHookRegistry,
  content: string,
) {
  return hooks.trigger({
    type: "tool_result",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "pwd" },
    content,
    isError: false,
  });
}

test("context inject reports cwd without changing the prompt", async () => {
  const { hooks, notifications } = setup(registerContextInjectHook);
  const result = await hooks.trigger({
    type: "user_prompt",
    prompt: "hello",
  });
  assert.equal(result, undefined);
  assert.deepEqual(notifications[0], {
    source: "context_inject",
    level: "info",
    message: `[HOOK] UserPromptSubmit: working in ${process.cwd()}`,
  });
});

test("log observer sees a tool call before a later block", async () => {
  const { hooks, notifications } = setup(registerLogHook);
  hooks.register("tool_call", () => ({
    block: true,
    reason: "later block",
  }));
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "pwd" },
  });
  assert.equal(notifications[0]?.source, "tool_log");
  assert.equal(notifications[0]?.message, "[HOOK] bash(...)");
});

test("large output warns only above 100000 characters", async () => {
  const atLimit = setup(registerLargeOutputHook);
  await triggerToolResult(atLimit.hooks, "x".repeat(100_000));
  assert.deepEqual(atLimit.notifications, []);

  const aboveLimit = setup(registerLargeOutputHook);
  await triggerToolResult(aboveLimit.hooks, "x".repeat(100_001));
  assert.deepEqual(aboveLimit.notifications, [{
    source: "large_output",
    level: "warning",
    message: "[HOOK] ⚠ Large output from bash (100001 characters)",
  }]);
});

test("summary counts tool messages and allows stop", async () => {
  const { hooks, notifications } = setup(registerSummaryHook);
  const result = await hooks.trigger({
    type: "stop",
    messages: [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "c1", name: "bash", content: "one", isError: false },
      { role: "tool", toolCallId: "c2", name: "bash", content: "two", isError: true },
    ],
  });
  assert.equal(result, undefined);
  assert.deepEqual(notifications.at(-1), {
    source: "summary",
    level: "info",
    message: "[HOOK] Stop: session used 2 tool calls",
  });
});

test("factory registers all five defaults", async () => {
  const ui = new NotificationUI();
  const hooks = createCodingHookRegistry({ cwd: process.cwd(), ui });

  await hooks.trigger({ type: "user_prompt", prompt: "hello" });
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "pwd" },
  });
  await triggerToolResult(hooks, "x".repeat(100_001));
  await hooks.trigger({ type: "stop", messages: [] });

  assert.deepEqual(
    ui.notifications.map((notification) => notification.source),
    ["context_inject", "tool_log", "large_output", "summary"],
  );
});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
npm run build
```

Expected: FAIL because the four Hook modules and factory do not exist.

- [ ] **Step 3: Implement each focused registration function**

Use these exact internal functions:

```ts
export function registerContextInjectHook(registry: CodingHookRegistry): void;
export function registerLogHook(registry: CodingHookRegistry): void;
export function registerLargeOutputHook(registry: CodingHookRegistry): void;
export function registerSummaryHook(registry: CodingHookRegistry): void;
```

`registerLogHook` and `registerLargeOutputHook` use `registerObserver()` and return immediately for other event types. Log emits exactly `[HOOK] ${event.toolName}(...)`. Large-output uses the raw Observer event content and does not return a patch.

- [ ] **Step 4: Assemble all five defaults in stable order**

In `createCodingHookRegistry()`:

```ts
const registry =
  new HookRegistry<AgentHookEvent, CodingHookContext>(context);
registerContextInjectHook(registry);
registerLogHook(registry);
registerLargeOutputHook(registry);
registerPermissionHook(registry);
registerSummaryHook(registry);
return registry;
```

Observer execution is always before control handlers regardless of registration order; the explicit order above keeps module assembly readable.

Create `hooks/index.ts` that exports `createCodingHookRegistry` and the public context/UI types required by internal consumers, but do not re-export individual registration functions from `src/coding-agent/index.ts`.

- [ ] **Step 5: Run focused verification**

```bash
npm run build
node --test dist/tests/coding-agent/hooks/defaults.test.js
node --test dist/tests/coding-agent/hooks/permission.test.js
npm run typecheck
```

Expected: all five default Hook tests PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/coding-agent/hooks/context-inject.ts src/coding-agent/hooks/log.ts src/coding-agent/hooks/large-output.ts src/coding-agent/hooks/summary.ts src/coding-agent/hooks/factory.ts src/coding-agent/hooks/index.ts tests/coding-agent/hooks/defaults.test.ts
git commit -m "feat: add default coding agent hooks"
```

---

### Task 7: Move Coding config to its owning package and assemble Hooks in `createHarness`

**Files:**

- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**

- Consumes: `HarnessProject`, `Session`, `SystemPromptBuilder`, `ModelConfig`, `StreamFn`, `CodingHookUI`, and `createCodingHookRegistry`.
- Produces:

```ts
export interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly ui?: CodingHookUI;
}
```

- `src/coding-agent/index.ts` publicly exports only `createCodingHookRegistry`, `createHarness`, and the approved Coding Hook types in addition to existing Coding exports.

- [ ] **Step 1: Add default assembly and per-Harness isolation tests**

Replace the old “no Hook console logs” test. Add these helpers:

```ts
function recordingUi(): {
  ui: CodingHookUI;
  notifications: HookNotification[];
} {
  const notifications: HookNotification[] = [];
  return {
    notifications,
    ui: {
      available: true,
      async confirm() { return true; },
      notify(notification) { notifications.push(notification); },
    },
  };
}

const oneTurnStream: StreamFn = async function* () {
  yield { type: "done", message: assistant };
};

function twoTurnBashStream(command: string): StreamFn {
  let turn = 0;
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "bash",
    arguments: { command },
  };
  return async function* () {
    turn++;
    if (turn === 1) {
      yield { type: "toolcall_start", id: call.id, name: call.name };
      yield { type: "toolcall_end", toolCall: call };
      yield {
        type: "done",
        message: {
          ...assistant,
          content: [call],
          stopReason: "toolUse",
        },
      };
      return;
    }
    yield { type: "done", message: assistant };
  };
}

test("factory assembles the default Hook registry with supplied UI", async () => {
  const { ui, notifications } = recordingUi();
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: async function* () {
      yield { type: "done", message: assistant };
    },
    model,
    session: Session.inMemory(),
    ui,
  });

  await harness.prompt("hello");
  assert.equal(notifications[0]?.source, "context_inject");
  assert.equal(notifications.at(-1)?.source, "summary");
});

test("factory defaults to fail-closed NO_UI for ask commands", async () => {
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: twoTurnBashStream("rm file.txt"),
    model,
    session: Session.inMemory(),
  });
  await harness.prompt("remove file");
  const toolMessage = harness.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /no confirmation UI available/);
});

test("factory creates independent Hook context for each Harness", async () => {
  const {
    ui: firstUi,
    notifications: firstNotifications,
  } = recordingUi();
  const {
    ui: secondUi,
    notifications: secondNotifications,
  } = recordingUi();
  const first = await createHarness({
    project: { workDir: "C:/first", storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
    ui: firstUi,
  });
  const second = await createHarness({
    project: { workDir: "C:/second", storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
    ui: secondUi,
  });
  await first.prompt("one");
  await second.prompt("two");
  assert.match(firstNotifications[0]?.message ?? "", /C:\/first/);
  assert.match(secondNotifications[0]?.message ?? "", /C:\/second/);
});
```

- [ ] **Step 2: Add compile-time/public import coverage**

In `tests/import-smoke.test.ts`, import:

```ts
import { HookRegistry } from "../src/agent/hooks/index.js";
import type {
  AgentHookEvent,
  AgentHookTrigger,
  Cleanup,
  ContextEvent,
  ContextResult,
  HookEvent,
  HookHandler,
  HookObserver,
  ResultOf,
  StopEvent,
  StopResult,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultPatch,
  Unregister,
  UserPromptEvent,
  UserPromptResult,
} from "../src/agent/hooks/index.js";

import {
  createCodingHookRegistry,
  createHarness,
} from "../src/coding-agent/index.js";
import type {
  CodingHookContext,
  CodingHookUI,
  CreateHarnessConfig,
  HookNotification,
  PermissionRequest,
} from "../src/coding-agent/index.js";
```

Add `HookRegistry` and `createCodingHookRegistry` to the runtime `void [...]` array. Keep type-only names in type assertions:

```ts
type PublicAgentHookTypes = [
  AgentHookEvent,
  AgentHookTrigger,
  Cleanup,
  ContextEvent,
  ContextResult,
  HookEvent<string>,
  HookHandler<UserPromptEvent, Record<string, never>>,
  HookObserver<AgentHookEvent, Record<string, never>>,
  ResultOf<UserPromptEvent>,
  StopEvent,
  StopResult,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultPatch,
  Unregister,
  UserPromptEvent,
  UserPromptResult,
];

type PublicCodingHookTypes = [
  CodingHookContext,
  CodingHookUI,
  CreateHarnessConfig,
  HookNotification,
  PermissionRequest,
];
void (null as PublicAgentHookTypes | null);
void (null as PublicCodingHookTypes | null);
```

- [ ] **Step 3: Verify the tests fail**

Run:

```bash
npm run build
```

Expected: FAIL because `CreateHarnessConfig` still belongs to the Agent Harness package and Factory does not accept UI or create Hooks.

- [ ] **Step 4: Move and assemble the Coding config**

Add `CreateHarnessConfig` to `src/coding-agent/types.ts`; remove any import of it from `agent/harness/types.ts`.

In `createHarness()`:

```ts
const hooks = createCodingHookRegistry({
  cwd: config.project.workDir,
  ui: config.ui ?? NO_UI,
});

return new AgentHarness({
  session,
  model: config.model,
  streamFn: config.streamFn,
  toolRegistry: createToolRegistry(config.project.workDir),
  systemPrompt: resolveSystemPrompt(config.systemPrompt),
  cwd: config.project.workDir,
  hooks,
});
```

Export from `src/coding-agent/index.ts`:

```ts
export { createCodingHookRegistry } from "./hooks/factory.js";
export type {
  CodingHookContext,
  CodingHookUI,
  CreateHarnessConfig,
  HookNotification,
  PermissionRequest,
} from "./types.js";
```

Do not export `NO_UI` or individual registration functions.

- [ ] **Step 5: Run Factory and import verification**

```bash
npm run build
node --test dist/tests/coding-agent/factory.test.js
node --test dist/tests/import-smoke.test.js
npm run typecheck
```

Expected: Factory defaults, isolation, and public import tests PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/coding-agent/types.ts src/coding-agent/factory.ts src/coding-agent/index.ts tests/coding-agent/factory.test.ts tests/import-smoke.test.ts
git commit -m "feat: assemble hooks in coding agent factory"
```

---

### Task 8: Implement the Coding Hook UI in CLI and inject it from `main`

**Files:**

- Modify: `src/cli/frontend.ts`
- Modify: `src/main.ts`
- Create: `tests/cli/frontend.test.ts`

**Interfaces:**

- Consumes: `CodingHookUI`, `PermissionRequest`, and `HookNotification` from `coding-agent/types.ts`.
- Produces:

```ts
export class CliFrontend implements CodingHookUI {
  readonly available = true;
  confirm(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  notify(notification: HookNotification): void;
}
```

- [ ] **Step 1: Add a test-only I/O seam and confirmation tests**

Define an internal constructor options type in `frontend.ts`:

```ts
interface CliFrontendOptions {
  readonly readline?: Interface;
  readonly input?: NodeJS.ReadStream;
  readonly write?: (text: string) => void;
  readonly log?: (text: string) => void;
}
```

The default constructor still creates the real readline/process adapters. Tests pass fakes.

In `tests/cli/frontend.test.ts`, add these fakes and fixtures:

```ts
import { EventEmitter } from "node:events";
import type { Interface } from "node:readline/promises";

type QuestionFn = (
  query: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    return this;
  }
}

const request: PermissionRequest = {
  toolCallId: "c1",
  toolName: "bash",
  input: { command: "rm file.txt" },
  reason: "file deletion requires approval",
};

function fakeReadline(question: QuestionFn): Interface {
  return {
    question,
    on() { return this; },
    close() {},
  } as unknown as Interface;
}

function frontendWithQuestion(
  question: QuestionFn,
  input = new FakeInput(),
  log: (text: string) => void = () => undefined,
): CliFrontend {
  return new CliFrontend({
    readline: fakeReadline(question),
    input: input as unknown as NodeJS.ReadStream,
    write: () => undefined,
    log,
  });
}

function frontendWithAnswer(answer: string): CliFrontend {
  return frontendWithQuestion(async () => answer);
}

function frontendWithLogs(logs: string[]): CliFrontend {
  return frontendWithQuestion(
    async () => "",
    new FakeInput(),
    (text) => logs.push(text),
  );
}

test("confirm accepts only y or yes and defaults to deny", async () => {
  for (const [answer, expected] of [
    ["y", true],
    ["YES", true],
    ["", false],
    ["n", false],
    ["anything", false],
  ] as const) {
    const cli = frontendWithAnswer(answer);
    assert.equal(await cli.confirm(request), expected);
    cli.close();
  }
});

test("confirm forwards AbortSignal to readline and returns false when aborted", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const cli = frontendWithQuestion(async (_prompt, options) => {
    assert.ok(options?.signal);
    seen.push(options.signal);
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });

  assert.equal(await cli.confirm(request, controller.signal), false);
  assert.equal(seen.length, 1);
  cli.close();
});

test("ESC cancels confirmation instead of invoking the run abort listener", async () => {
  const input = new FakeInput();
  const cli = frontendWithQuestion((_prompt, options) =>
    new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
      input.emit("data", Buffer.from([0x1b]));
    }), input);

  assert.equal(await cli.confirm(request), false);
  cli.close();
});

test("notify renders the supplied Hook message", () => {
  const logs: string[] = [];
  const cli = frontendWithLogs(logs);
  cli.notify({
    source: "summary",
    level: "info",
    message: "[HOOK] Stop: session used 2 tool calls",
  });
  assert.deepEqual(logs, ["[HOOK] Stop: session used 2 tool calls"]);
  cli.close();
});
```

- [ ] **Step 2: Add run-listener suspension/restoration coverage**

Add:

```ts
test("run suspends its ESC listener during confirm and restores it after", async () => {
  const input = new FakeInput();
  let mainQuestions = 0;
  let aborts = 0;
  const cli = frontendWithQuestion(async (query) => {
    if (query.includes("Allow?")) {
      assert.equal(input.listenerCount("data"), 1);
      return "y";
    }
    mainQuestions++;
    return mainQuestions === 1 ? "run command" : "q";
  }, input);

  const harness = {
    subscribe() {
      return () => undefined;
    },
    abort() {
      aborts++;
    },
    async prompt() {
      assert.equal(input.listenerCount("data"), 1);
      assert.equal(await cli.confirm(request), true);
      assert.equal(input.listenerCount("data"), 1);
      input.emit("data", Buffer.from([0x1b]));
    },
  } as unknown as AgentHarness;

  await cli.run(harness);
  assert.equal(aborts, 1);
  assert.equal(input.listenerCount("data"), 0);
  cli.close();
});
```

The single listener observed during `confirm()` is the temporary confirmation ESC listener; the run listener has already been removed. The listener observed immediately after `confirm()` is the restored run listener.

- [ ] **Step 3: Verify tests fail**

Run:

```bash
npm run build
```

Expected: FAIL because `CliFrontend` does not implement `CodingHookUI`, has no confirm/notify, and has no injectable I/O seam.

- [ ] **Step 4: Implement confirmation without policy knowledge**

Refactor the current local run-input listener into private attach/detach helpers. `confirm()`:

1. detaches the active run ESC listener;
2. installs a temporary ESC listener backed by a local `AbortController`;
3. combines the local and run signals with `AbortSignal.any`;
4. calls the same readline interface:

```ts
const answer = await this.readline.question(
  `\n⚠ ${request.reason}\n   Tool: ${request.toolName}(${JSON.stringify(request.input)})\n   Allow? [y/N] `,
  { signal: confirmationSignal },
);
return ["y", "yes"].includes(answer.trim().toLowerCase());
```

5. returns `false` for an aborted question;
6. rethrows unrelated readline errors;
7. removes the temporary listener and restores the run listener in `finally`.

`notify()` calls the injected/default `log` exactly once with `notification.message`. It does not classify commands.

- [ ] **Step 5: Inject CLI before Harness creation**

Keep:

```ts
const cli = new CliFrontend();
```

before Factory assembly, and add:

```ts
const harness = await createHarness({
  project,
  streamFn: stream,
  model: defaultModel,
  session,
  ui: cli,
});
await cli.run(harness);
```

Retain `finally { cli.close(); }`.

- [ ] **Step 6: Run CLI and main verification**

```bash
npm run build
node --test dist/tests/cli/frontend.test.js
node --test dist/tests/main.test.js
node --test dist/tests/import-smoke.test.js
npm run typecheck
```

Expected: confirmation, ESC/Abort, notification, main import, and existing rendering tests PASS.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/cli/frontend.ts src/main.ts tests/cli/frontend.test.ts
git commit -m "feat: connect hook permissions to cli"
```

---

### Task 9: Rewrite README surfaces around actual package boundaries

**Files:**

- Modify: `src/agent/README.md`
- Modify: `src/agent/harness/README.md`
- Create: `src/coding-agent/README.md`
- Modify carefully without staging unrelated rewrite: `docs/architecture.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the final exports and runtime behavior from Tasks 1–8.
- Produces: user-facing documentation that lists the complete actual public surface of each package.

- [ ] **Step 1: Inventory actual exports before writing prose**

Run:

```bash
rg -n "^export " src/index.ts src/ai/index.ts src/agent/hooks/index.ts src/agent/harness/index.ts src/agent/tools/index.ts src/coding-agent/index.ts
```

Record every value and type in the relevant README tables. Do not infer exports from implementation files.

- [ ] **Step 2: Rewrite `src/agent/README.md`**

Use this section order:

1. minimal `runAgentLoop()` usage;
2. run/turn/tool-loop concepts;
3. `AgentEvent` + `AgentHarness.subscribe()` as observation;
4. Hook as control, including the five events and exact combination table;
5. `HookRegistry` complete API, context/snapshot/signal/error/lifecycle semantics;
6. Tools complete API;
7. `AgentLoopConfig` and `AgentHookTrigger`;
8. full Agent-related exports;
9. imports from `ai` and forbidden upper-layer dependencies.

Include this explicit distinction:

```text
subscribe 的返回值被忽略，只能观察运行事实；Hook 在动作提交前触发，
只有事件定义的结果可以阻止、转换、修补或续跑。两者不是两套同义回调。
```

Remove `pre_turn`, Hook `turn_end`, `ReduceStrategy`, reducer maps, and `trigger(type, event)`.

- [ ] **Step 3: Correct `src/agent/harness/README.md`**

Document:

- `HarnessConfig.hooks?: AgentHookTrigger`;
- Harness passes that trigger unchanged to Agent Loop;
- Harness does not expose `register()` or define Hook events;
- `subscribe()` observes `AgentEvent` and cannot control a run;
- no Harness EventBus, second Hook registry, or ExtensionHost;
- `CreateHarnessConfig` belongs to `coding-agent`, not generic Harness;
- all current Harness/Session exports from `src/agent/harness/index.ts`.

Remove the contradictory existing statement that the Hook subsystem is removed.

- [ ] **Step 4: Create `src/coding-agent/README.md`**

Use this order:

1. `createHarness()` usage with optional `ui`;
2. Coding Agent responsibilities;
3. five default Hooks and exact behavior;
4. allow/ask/deny Bash policy and fail-closed no-UI behavior;
5. `CodingHookUI`, `CodingHookContext`, notifications and confirmation request;
6. `createCodingHookRegistry()` for custom composition;
7. complete public exports from `src/coding-agent/index.ts`;
8. dependency direction: CLI implements the port, Coding Agent never imports CLI;
9. internal-only names: `NO_UI` and five registration functions.

Explicitly explain that `contextInjectHook` retains the teaching name but only notifies cwd because the system prompt already contains cwd.

- [ ] **Step 5: Correct the root README**

Replace stale descriptions of:

- one global async LLM client;
- `createLLMClient()`, `invoke()`, `LLMResponse`, and `response_done`;
- `AgentSession`;
- old `PermissionHook` gates for all Bash/write/edit calls;
- obsolete `ToolRegistry`/`Tool` names.

Describe the actual startup path:

```text
createStreamFn → SessionManager → createHarness → CliFrontend
```

Link to the AI, Agent, Harness, and Coding Agent READMEs rather than duplicating their full design rationale.

- [ ] **Step 6: Update only the Hook-related architecture content**

First inspect:

```bash
git diff -- docs/architecture.md
```

Preserve the entire pre-existing working-tree rewrite. Update its current Hook sections and data-flow text to show:

```text
AgentEvent → AgentHarness.subscribe → UI rendering       (observation)
Agent Loop → AgentHookTrigger → Coding HookRegistry → UI (control)
```

Remove reducer, `pre_turn`, and Hook `turn_end` references. Add `coding-agent/hooks/`, `coding-agent/types.ts`, and `bash-policy.ts` to its directory map.

- [ ] **Step 7: Check documentation against code**

Run:

```bash
rg -n "createLLMClient|AgentSession|ReduceStrategy|pre_turn|trigger\\([^)]*type|PermissionHook" README.md src/agent/README.md src/agent/harness/README.md src/coding-agent/README.md docs/architecture.md
```

Expected: no stale API claims. A mention of the concrete permission Hook in the new Coding README is allowed only under its current lowercase/default-Hook name.

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit clean documentation files without absorbing the existing architecture rewrite**

Stage:

```bash
git add README.md src/agent/README.md src/agent/harness/README.md src/coding-agent/README.md
git commit -m "docs: explain agent hook boundaries"
```

Do not stage `docs/architecture.md` unless its pre-existing rewrite has independently become clean or its Hook-only changes can be isolated without including user-owned hunks. Leave it modified and report that fact in the final handoff.

---

### Task 10: Run the complete contract and boundary audit

**Files:**

- Modify only if an audit exposes a defect: the task file that owns that defect and its focused test.
- Do not modify or stage the pre-existing AI files.

**Interfaces:**

- Consumes: all preceding tasks.
- Produces: a verified implementation with no old Hook API, forbidden dependency, public export omission, or untested control path.

- [ ] **Step 1: Prove the old Hook model is gone**

Run:

```bash
rg -n "ReduceStrategy|DEFAULT_REDUCERS|pre_turn|hooks\\.trigger\\([\"']|register\\([\"']turn_end|transformContext|beforeToolCall|afterToolCall|shouldStopAfterTurn" src tests
```

Expected: no matches. `AgentEvent`'s ordinary `"turn_end"` remains valid; only Hook registration/trigger references are forbidden.

- [ ] **Step 2: Prove layer boundaries**

Run:

```bash
rg -n "coding-agent|cli/" src/agent
rg -n "\\.\\./cli|/cli/" src/coding-agent
rg -n "agent|coding-agent|harness|cli" src/ai
```

Expected: no forbidden downward-package imports. Legitimate prose comments must not describe a source dependency.

- [ ] **Step 3: Run type and focused behavior suites**

```bash
npm run typecheck
npm run build
node --test dist/tests/agent/hooks/registry.test.js
node --test dist/tests/agent/agent-loop.test.js
node --test dist/tests/coding-agent/agent-harness.test.js
node --test dist/tests/coding-agent/hooks/permission.test.js
node --test dist/tests/coding-agent/hooks/defaults.test.js
node --test dist/tests/coding-agent/tools/bash.test.js
node --test dist/tests/coding-agent/factory.test.js
node --test dist/tests/cli/frontend.test.js
node --test dist/tests/import-smoke.test.js
```

Expected: every command PASS.

- [ ] **Step 4: Run the full suite**

```bash
npm test
```

Expected: all existing and new tests PASS with zero failures, cancellations, skips, or todos.

- [ ] **Step 5: Inspect final changes and commits**

Run:

```bash
git status --short
git diff --check
git log --oneline 9d77a16..HEAD
```

Expected:

- only the five pre-existing AI/architecture working-tree changes remain uncommitted, plus `docs/architecture.md` Hook edits if they could not be isolated;
- no whitespace errors;
- one focused commit per task;
- no unrelated file in any task commit.

- [ ] **Step 6: Commit only audit fixes, if any**

If Step 1–4 required a source correction, stage only that owning source file and its regression test, then commit:

```bash
git commit -m "fix: close agent hook contract gaps"
```

If no correction was needed, do not create an empty commit.
