# Unified Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Agent Hooks, Agent Loop `yield`, and Harness EventBus with one extensible `Events` dispatcher shared by every Session in a Project.

**Architecture:** `EventMap` is the single compile-time event contract and `Events` is the runtime dispatcher. A Project constructs one `Events`; Harness and Agent receive that same instance. Control uses `ask()` or `transform()`, facts use `emit()`, and Session persistence remains owned by Harness through `AgentContext.appendMessage()`.

**Tech Stack:** TypeScript 7, Node.js 24, `node:test`, ESM with `NodeNext` resolution.

## Global Constraints

- Preserve the approved four boundaries: AI request, Agent Run, Harness Session, Coding Project.
- Keep `StreamFn` as `AsyncIterable<StreamChunk>`; it is data transport, not a runtime event dispatcher.
- The runtime implementation must contain no event-name `switch` and no fixed Hook callback fields.
- One Project creates exactly one `Events`; every Harness opened by that Project receives the same instance.
- Do not keep compatibility aliases for `HookRegistry`, `AgentEvent`, `HarnessEvent`, `HarnessEventBus`, or `AssistantMessageEvent`.
- Do not add `projectId` to every event. Project identity comes from the `Events` instance; Session and Run facts carry `sessionId`, `runId`, and `lane`.
- Complete messages must be persisted before their completion facts are emitted.
- Account for the existing uncommitted `hooks/builtin/` and `tools/builtin/bash/` directory reorganization. The Hook path is intentionally superseded by Task 3; the Bash move is not part of this feature and must not be staged in an Events commit unless the user has committed it before execution.
- Todo, tool presentation behavior, and interaction UI remain functionally unchanged.

## Execution Precondition

The working tree currently contains an unfinished directory-only move from `tools/builtin/bash.ts` and `tools/builtin/bash-policy.ts` into `tools/builtin/bash/`, plus the corresponding Hook move. Before Task 1 starts, the repository owner must either commit that work or preserve it outside the implementation worktree. The event implementation must use the resulting Bash policy path, but must not silently absorb unrelated uncommitted files into an Events commit.

---

### Task 1: Add the generic Events dispatcher

**Files:**
- Create: `src/events/types.ts`
- Create: `src/events/events.ts`
- Create: `src/events/index.ts`
- Create: `tests/events/events.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: no domain event names.
- Produces: `EventContract`, augmentable `EventMap`, `Events`, `EventListenerErrorHandler`, and idempotent `Unregister`.

- [ ] **Step 1: Write dispatcher contract tests**

Add a test-local `declare module "../../src/events/types.js"` augmentation with one event for each mode:

```ts
declare module "../../src/events/types.js" {
  interface EventMap {
    "test/fact": EventContract<"emit", { readonly value: number }>;
    "test/question": EventContract<"ask", { readonly prompt: string }, string>;
    "test/value": EventContract<"transform", number, number>;
  }
}
```

Test all of these exact invariants:

```ts
test("emit snapshots listeners, preserves order, and isolates failures", async () => {
  const failures: string[] = [];
  const calls: string[] = [];
  const events = new Events((error, dispatch) => {
    failures.push(`${dispatch.name}:${(error as Error).message}`);
  });
  let unregisterSecond = () => undefined;
  events.on("test/fact", async () => {
    calls.push("first");
    unregisterSecond();
    throw new Error("broken");
  });
  unregisterSecond = events.on("test/fact", () => { calls.push("second"); });

  await events.emit("test/fact", { value: 1 });
  await events.emit("test/fact", { value: 2 });

  assert.deepEqual(calls, ["first", "second", "first"]);
  assert.deepEqual(failures, ["test/fact:broken", "test/fact:broken"]);
});
```

Also test that `ask()` returns the first non-`undefined` answer without invoking later listeners; `transform()` passes each returned value to the next middleware; middleware may stop the chain by returning without `next()`; `ask()` and `transform()` propagate listener errors; both check an already-aborted signal; and `Unregister` is idempotent.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node --test dist/tests/events/events.test.js`

Expected: build fails because `src/events/index.ts` and `Events` do not exist.

- [ ] **Step 3: Implement static contracts**

In `src/events/types.ts`, define:

```ts
export type EventMode = "emit" | "ask" | "transform";

export interface EventContract<
  TMode extends EventMode,
  TInput,
  TResult = void,
> {
  readonly mode: TMode;
  readonly input: TInput;
  readonly result: TResult;
}

export interface EventMap {}

export interface EventDispatch {
  readonly name: keyof EventMap & string;
  readonly input: unknown;
}

export type EventListenerErrorHandler = (
  error: unknown,
  dispatch: EventDispatch,
) => void;

export type Unregister = () => void;
```

Add these conditional helper types so `on()` infers the listener signature from the selected event's `mode` and callers never cast domain payloads:

```ts
export type EventName = keyof EventMap & string;
export type ContractOf<TName extends EventName> = EventMap[TName];
export type EventInput<TName extends EventName> =
  ContractOf<TName> extends EventContract<EventMode, infer TInput, unknown>
    ? TInput
    : never;
export type EventResult<TName extends EventName> =
  ContractOf<TName> extends EventContract<EventMode, unknown, infer TResult>
    ? TResult
    : never;

export type NamesWithMode<TMode extends EventMode> = {
  [TName in EventName]: ContractOf<TName> extends EventContract<TMode, unknown, unknown>
    ? TName
    : never;
}[EventName];

export type EmitEventName = NamesWithMode<"emit">;
export type AskEventName = NamesWithMode<"ask">;
export type TransformEventName = NamesWithMode<"transform">;

export type EventListener<TName extends EventName> =
  ContractOf<TName> extends EventContract<"emit", infer TInput, unknown>
    ? (input: TInput) => void | Promise<void>
    : ContractOf<TName> extends EventContract<"ask", infer TInput, infer TResult>
      ? (input: TInput, signal?: AbortSignal) => TResult | undefined | Promise<TResult | undefined>
      : ContractOf<TName> extends EventContract<"transform", infer TInput, infer TResult>
        ? (
            input: TInput,
            next: (value: TResult) => Promise<TResult>,
            signal?: AbortSignal,
          ) => TResult | Promise<TResult>
        : never;
```

- [ ] **Step 4: Implement runtime dispatch**

In `src/events/events.ts`, implement one listener map and these public methods:

```ts
export class Events {
  constructor(onListenerError?: EventListenerErrorHandler);

  on<TName extends keyof EventMap & string>(
    name: TName,
    listener: EventListener<TName>,
  ): Unregister;

  emit<TName extends EmitEventName>(
    name: TName,
    input: EventInput<TName>,
  ): Promise<void>;

  ask<TName extends AskEventName>(
    name: TName,
    input: EventInput<TName>,
    signal?: AbortSignal,
  ): Promise<EventResult<TName> | undefined>;

  transform<TName extends TransformEventName>(
    name: TName,
    input: EventInput<TName>,
    signal?: AbortSignal,
  ): Promise<EventResult<TName>>;
}
```

Use a listener snapshot at the start of every dispatch. `emit()` catches each listener failure and safely invokes `onListenerError`; `ask()` and `transform()` do not catch listener failures. Check `signal?.throwIfAborted()` before dispatch and after every awaited control listener. Implement `transform()` as a recursive `next(value)` chain; a listener that returns without calling `next()` ends the chain.

- [ ] **Step 5: Export and verify the dispatcher**

Export runtime and types from `src/events/index.ts`, then add `export * from "./events/index.js";` to `src/index.ts`.

Run: `npm run build && node --test dist/tests/events/events.test.js`

Expected: all dispatcher tests pass.

- [ ] **Step 6: Commit the dispatcher**

```powershell
git add src/events src/index.ts tests/events/events.test.ts
git commit -m "feat: add extensible events dispatcher"
```

---

### Task 2: Rename AI stream elements to StreamChunk

**Files:**
- Modify: `src/ai/types.ts`
- Modify: `src/ai/index.ts`
- Modify: `src/ai/factory.ts`
- Modify: `src/ai/adapters/anthropic.ts`
- Modify: `src/ai/adapters/gemini.ts`
- Modify: `src/ai/adapters/openai.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `tests/ai/fixtures.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/import-smoke.test.ts`
- Modify: `src/ai/README.md`
- Modify: `src/agent/README.md`

**Interfaces:**
- Consumes: existing streaming payload union without behavior changes.
- Produces: `StreamChunk` and `StreamFn = (...) => AsyncIterable<StreamChunk>`.

- [ ] **Step 1: Change the public type assertion first**

Update the AI import smoke/type assertions to import `StreamChunk` and remove `AssistantMessageEvent`. Do not add an alias.

- [ ] **Step 2: Run typecheck and verify RED**

Run: `npm run typecheck`

Expected: missing exported member `StreamChunk`.

- [ ] **Step 3: Perform the mechanical rename**

Rename only the type, not the streaming discriminants:

```ts
export type StreamChunk =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "toolcall_start"; readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta"; readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end"; readonly toolCall: ToolCall }
  | { readonly type: "done"; readonly message: AssistantMessage }
  | { readonly type: "error"; readonly message: AssistantMessage };
```

Update adapters, factory interfaces, Agent Loop imports, test fixtures, and `StreamFn`. The values yielded by adapters must remain byte-for-byte equivalent.

- [ ] **Step 4: Update the AI README terminology**

Explain in one paragraph that a `StreamChunk` is a piece of one provider response and is consumed directly by Agent; it is not registered, published, or observed through `Events`.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run build && node --test "dist/tests/ai/*.test.js"`

Expected: AI tests pass and `rg -n "AssistantMessageEvent" src tests` returns no matches.

```powershell
git add src/ai src/agent/agent-loop.ts src/ai/README.md src/agent/README.md tests/ai tests/agent/agent-loop.test.ts tests/import-smoke.test.ts
git commit -m "refactor: name provider output stream chunks"
```

---

### Task 3: Replace Agent Hooks with control events

**Files:**
- Create: `src/agent/events.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/harness/agent-harness.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Create: `src/coding-agent/events/factory.ts`
- Create: `src/coding-agent/events/builtin/permission.ts`
- Create: `tests/agent/control-events.test.ts`
- Create: `tests/coding-agent/events/permission.test.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`
- Delete: `src/agent/hooks/index.ts`
- Delete: `src/agent/hooks/registry.ts`
- Delete: `src/agent/hooks/types.ts`
- Delete: `src/coding-agent/hooks/factory.ts`
- Delete: `src/coding-agent/hooks/builtin/permission.ts`
- Delete: `tests/agent/hooks/registry.test.ts`
- Delete: `tests/coding-agent/hooks/permission.test.ts`

**Interfaces:**
- Consumes: `Events` from Task 1 and existing Agent Loop facts temporarily yielded until Task 4.
- Produces: Agent-owned control event contracts, `AgentRunIdentity`, `ToolCallDecision`, and Project-owned Permission registration.

- [ ] **Step 1: Write tests for declaration-based Agent control events**

Cover these behaviors through the real `runAgentLoop()`:

- `agent/user-prompt` uses `ask()` and a returned rejection prevents message insertion and model invocation.
- `agent/context` uses `transform()` and the transformed messages reach `StreamFn` without replacing Session history.
- `agent/tool-call` uses `transform()`; listeners can replace arguments or return a terminal rejection.
- `agent/tool-result` uses `transform()`; the transformed result is identical in the tool message and the next model request.
- `agent/stop` uses `ask()`; `continueWith` is appended before the next turn.
- The same AbortSignal reaches every control listener.

Use an explicit identity in every test:

```ts
const run = { sessionId: "session-1", runId: "run-1", lane: "main" } as const;
```

- [ ] **Step 2: Write Permission tests against Events**

Register Permission on a fresh `Events` and call `transform("agent/tool-call", decision, signal)`. Assert allow passes through, deny returns `kind: "reject"`, ask calls `interactions.confirm()`, user rejection returns reject, and thrown confirmation fails closed.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm run build`

Expected: missing Agent event declarations and coding event factory.

- [ ] **Step 4: Declare Agent control contracts**

In `src/agent/events.ts`, define:

```ts
export interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly lane: string;
}

export type ToolCallDecision =
  | (AgentRunIdentity & { readonly kind: "execute"; readonly call: AgentToolCall })
  | (AgentRunIdentity & {
      readonly kind: "reject";
      readonly call: AgentToolCall;
      readonly reason: string;
    });
```

Augment `EventMap` with these exact contracts:

```ts
"agent/user-prompt": EventContract<
  "ask",
  AgentRunIdentity & { readonly prompt: string },
  { readonly block: true; readonly reason?: string }
>;
"agent/context": EventContract<
  "transform",
  AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
  AgentRunIdentity & { readonly messages: readonly AgentMessage[] }
>;
"agent/tool-call": EventContract<"transform", ToolCallDecision, ToolCallDecision>;
"agent/tool-result": EventContract<
  "transform",
  AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult },
  AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult }
>;
"agent/stop": EventContract<
  "ask",
  AgentRunIdentity & { readonly messages: readonly AgentMessage[] },
  { readonly continueWith: AgentMessage }
>;
```

- [ ] **Step 5: Replace Hook calls in Agent Loop**

Change `AgentLoopConfig` to:

```ts
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  readonly events: Events;
  readonly run: AgentRunIdentity;
}
```

Replace each `hooks.trigger()` with the matching `ask()` or `transform()`. Keep the current generator facts during this task only. Preserve owner error rules: tool-call failure becomes rejection; tool-result failure becomes an error result; user-prompt/context/stop failures reject the run.

Create the initial Tool Call decision from a cloned working call:

```ts
const decision: ToolCallDecision = {
  ...config.run,
  kind: "execute",
  call: { ...originalCall, arguments: structuredClone(originalCall.arguments) },
};
```

Listeners return a new decision or pass one to `next()`; they must not mutate the model's original `AgentToolCall`.

- [ ] **Step 6: Make one Events instance Project-owned**

Make `HarnessConfig.events: Events` required and pass it into `AgentLoopConfig`. Change `CreateProjectConfig.onEventListenerError` to `EventListenerErrorHandler`. Add `readonly events: Events` to `Project`.

In `createProject()`:

```ts
const events = new Events(config.onEventListenerError);
registerCodingEvents(events, interactions);
```

Capture this one instance in `bindSession()` so `createSession()`, `openSession()`, and `continueRecent()` all construct Harnesses with the same `events`. Return that instance as `project.events`.

- [ ] **Step 7: Reimplement Permission as a coding event listener**

`registerCodingEvents(events, interactions)` calls `registerPermission(events, interactions)`. Permission registers only `agent/tool-call`; it closes over `interactions`, so the generic dispatcher has no context box. Non-Bash and allow decisions call `next(decision)`. Deny, user rejection, and confirmation failure return a `kind: "reject"` decision without calling `next()`.

- [ ] **Step 8: Delete Hook infrastructure and update all callers**

Remove Hook exports and imports. Update tests constructing standalone Harnesses to pass `events: new Events()`. Do not retain deprecated aliases, no-op Hook registries, or `hooks?:` fields.

- [ ] **Step 9: Verify and commit control migration**

Run: `npm run test`

Expected: all tests pass; `rg -n "HookRegistry|AgentHook|hooks\.trigger|createCodingHooks|registerPermissionHook" src tests` returns no matches outside historical design documents.

```powershell
git add src/agent src/harness/types.ts src/harness/agent-harness.ts src/coding-agent/types.ts src/coding-agent/factory.ts src/coding-agent/events tests/agent tests/harness/agent-harness.test.ts tests/coding-agent/factory.test.ts tests/coding-agent/events tests/import-smoke.test.ts
git add -A -- src/coding-agent/hooks tests/coding-agent/hooks
git commit -m "refactor: replace agent hooks with control events"
```

---

### Task 4: Move Agent facts and Session persistence onto Events

**Files:**
- Modify: `src/agent/events.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/harness/agent-harness.ts`
- Create: `src/harness/events.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/coding-agent/project/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/ui/presentation.ts`
- Modify: `src/ui/cli-harness-renderer.ts`
- Modify: `src/ui/cli-frontend.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/coding-agent/ui/presentation.test.ts`
- Modify: `tests/ui/cli-frontend.test.ts`
- Modify: `tests/ui/cli-harness-renderer.test.ts`
- Modify: `tests/main.test.ts`
- Delete: `src/harness/events/event-bus.ts`
- Delete: `src/harness/events/index.ts`
- Delete: `src/harness/events/types.ts`
- Delete: `tests/harness/events.test.ts`

**Interfaces:**
- Consumes: Project-owned `Events`, Agent control contracts, Session append APIs, and existing tool presentation implementations.
- Produces: fact event contracts, `runAgentLoop(...): Promise<void>`, persistence-first `AgentContext`, Harness run facts, and UI subscriptions directly on Project events.

- [ ] **Step 1: Rewrite Agent Loop tests around emitted facts**

Replace the generator `collect()` helper with listeners on `Events`. Assert event order by registering the fact names used in each scenario. Change the return assertion to:

```ts
const result: Promise<void> = runAgentLoop(
  "hello",
  context,
  { model, convertToLlm, events, run },
  streamFn,
  signal,
);
await result;
```

Add a persistence-order assertion: inside `agent/turn-end`, `agent/tool-end`, and `agent/tool-rejected` listeners, inspect the fake context's committed messages and verify the corresponding complete message is already present.

- [ ] **Step 2: Rewrite Harness and CLI tests against the Project Events instance**

Harness tests subscribe with `events.on("harness/run-start", ...)` and named Agent fact listeners. CLI renderer tests bind a renderer to Events for `session-1`, emit events for both `session-1` and `session-2`, and assert only the selected Session renders.

- [ ] **Step 3: Run the focused build and verify RED**

Run: `npm run build`

Expected: `runAgentLoop()` still returns `AsyncIterable<AgentEvent>` and Harness still exposes its old EventBus.

- [ ] **Step 4: Declare Agent fact events**

Extend `EventMap` in `src/agent/events.ts` with:

```ts
"agent/turn-start": EventContract<"emit", AgentRunIdentity>;
"agent/turn-end": EventContract<"emit", AgentRunIdentity & { readonly message: AgentMessage }>;
"agent/text-delta": EventContract<"emit", AgentRunIdentity & { readonly text: string }>;
"agent/thinking-delta": EventContract<"emit", AgentRunIdentity & { readonly thinking: string }>;
"agent/toolcall-start": EventContract<"emit", AgentRunIdentity & { readonly id: string; readonly name: string }>;
"agent/toolcall-delta": EventContract<"emit", AgentRunIdentity & { readonly id: string; readonly argumentsDelta: string }>;
"agent/toolcall-end": EventContract<"emit", AgentRunIdentity & { readonly toolCall: AgentToolCall }>;
"agent/tool-start": EventContract<"emit", AgentRunIdentity & { readonly call: AgentToolCall }>;
"agent/tool-end": EventContract<"emit", AgentRunIdentity & { readonly call: AgentToolCall; readonly result: AgentToolResult }>;
"agent/tool-rejected": EventContract<"emit", AgentRunIdentity & {
  readonly call: AgentToolCall;
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult;
  readonly reason: ToolRejectedReason;
}>;
```

Keep `ToolRejectedReason` in `agent/events.ts`; remove `AgentEvent`, `ToolRejectedEvent`, `agent_start`, and `agent_end` from `agent/types.ts`.

- [ ] **Step 5: Make AgentContext persistence explicit**

Change the context to:

```ts
export interface AgentContext {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolRegistry;
  appendMessage(message: AgentMessage): Promise<void>;
}
```

Replace every `context.messages.push(message)` with `await context.appendMessage(message)`. Local request arrays remain mutable copies passed to `convertToLlm()`.

- [ ] **Step 6: Convert Agent Loop to Promise and emit facts**

Change the signature to `Promise<void>`. Replace each `yield` with `await config.events.emit(name, { ...config.run, ...payload })`. Do not emit Agent-level run boundaries. Preserve streaming order and sequential Tool execution. Check the AbortSignal after every awaited `ask()` or `transform()` and before tool execution; an abort must win over a late listener answer.

- [ ] **Step 7: Declare Harness run facts**

In `src/harness/events.ts`, augment `EventMap` with:

```ts
export const MAIN_LANE = "main";

export type HarnessRunEndInput = AgentRunIdentity & (
  | { readonly reason: "completed" | "aborted" }
  | { readonly reason: "error"; readonly errorMessage: string }
);

declare module "../events/types.js" {
  interface EventMap {
    "harness/run-start": EventContract<"emit", AgentRunIdentity>;
    "harness/run-end": EventContract<"emit", HarnessRunEndInput>;
  }
}
```

There is no `HarnessEvent` union and no lifting function.

- [ ] **Step 8: Simplify AgentHarness around one direct run**

Remove `HarnessEventBus`, `runPrompt()`, `persistNewMessages()`, `persistedMessageCount`, and `subscribe()`. Store the injected `Events` instance. In `prompt()`:

1. create the Run's `AbortController` and store it in `activeRun` before any asynchronous preparation;
2. create `run = { sessionId: this.session.id, runId: randomUUID(), lane: MAIN_LANE }`;
3. prepare the system prompt and stop without a run-start if cancellation happened during preparation;
4. emit `harness/run-start`;
5. call `await runAgentLoop(...)` once, passing `_messages` itself as the context's readonly view rather than a copy;
6. implement `appendMessage` as `await session.appendMessage(message)` followed by `_messages.push(message)` and `maybeStartTitle()`;
7. in `finally`, clear `activeRun` and emit exactly one `harness/run-end` if start was emitted;
8. classify a cancelled signal as `aborted` and suppress its cancellation error; rethrow non-cancellation failures after emitting `reason: "error"`.

- [ ] **Step 9: Move tool presentation off Harness event types**

In `src/coding-agent/ui/presentation.ts`, define the presentation-only union:

```ts
export type ToolPresentationInput =
  | { readonly type: "tool_start"; readonly call: AgentToolCall }
  | { readonly type: "tool_end"; readonly call: AgentToolCall; readonly result: AgentToolResult }
  | ({ readonly type: "tool_rejected" } & ToolPresentationRejected<unknown>);
```

`CodingToolPresentationRegistry.render()` accepts this type. Rename `Project.renderToolEvent()` to `renderTool(input: ToolPresentationInput): string`. This union contains only data required for rendering; it is not registrable, is not published, and carries no Session/Run identity.

- [ ] **Step 10: Bind CLI rendering directly to Events**

Replace `CliHarnessRenderer.render(HarnessEvent)` with:

```ts
bind(events: Events, sessionId: string): Unregister;
```

Inside `bind()`, register listeners for text, thinking, Tool Call stream, Tool execution, `harness/run-start`, and `harness/run-end`. Each listener first checks `input.sessionId === sessionId`. Tool listeners project their input into `ToolPresentationInput`. Keep a tool count keyed by `runId`: initialize it on run-start, increment it on tool-end and tool-rejected, print and delete it on run-end. The returned unregister function calls every registration exactly once.

In `CliFrontend.run()`, use `renderer.bind(project.events, harness.sessionId)`. Keep `harness.prompt()` and `harness.abort()` as the Session control surface.

- [ ] **Step 11: Verify fact migration and commit**

Run: `npm run test`

Expected: all tests pass, concurrent Session filtering passes, and these scans return no source matches:

```powershell
rg -n "AgentEvent|HarnessEvent|HarnessEventBus|liftAgentEvent|runPrompt|persistNewMessages|persistedMessageCount|harness\.subscribe|\.publish\(" src tests
rg -n "async function\* runAgentLoop|for await \(const event of runAgentLoop|yield \{ type: \"agent_" src tests
```

```powershell
git add src/agent src/harness src/coding-agent src/ui tests
git commit -m "refactor: publish agent and harness facts through events"
```

---

### Task 5: Lock down cancellation, failure, and multi-Session invariants

**Files:**
- Modify: `tests/events/events.test.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify when required by a failing invariant: `src/events/events.ts`, `src/agent/agent-loop.ts`, `src/harness/agent-harness.ts`, or `src/coding-agent/factory.ts`.

**Interfaces:**
- Consumes: completed unified event path from Tasks 1–4.
- Produces: regression coverage for the design's error and ownership rules.

- [ ] **Step 1: Add the failure matrix tests**

Add separate tests proving:

- an `emit` listener can throw while the next listener still runs and the Agent Run completes;
- user-prompt, context, and stop listener failures reject the Agent Run;
- tool-call listener failure never executes the Tool and persists/emits a rejected result;
- tool-result listener failure persists/emits an error Tool Result;
- an AbortSignal fired while Permission is awaiting confirmation wins over the returned confirmation;
- once `harness/run-start` is observed, exactly one `harness/run-end` follows for completed, aborted, and error cases.

- [ ] **Step 2: Add Project sharing and isolation tests**

In the Project factory test, open two Sessions from one Project and assert both publish through `project.events`. Create a second Project and assert its listeners receive none of the first Project's facts. Use `sessionId` to distinguish concurrent facts within the first Project.

- [ ] **Step 3: Run focused tests and fix only demonstrated defects**

Run:

```powershell
npm run build
node --test dist/tests/events/events.test.js dist/tests/agent/agent-loop.test.js dist/tests/harness/agent-harness.test.js dist/tests/coding-agent/factory.test.js
```

Expected: all focused tests pass. If a test fails, change only the owner named by the design: `Events` for dispatch semantics, Agent for Tool/control semantics, Harness for Run classification, or Project for instance ownership.

- [ ] **Step 4: Commit invariant coverage**

```powershell
git add tests/events tests/agent tests/harness tests/coding-agent src/events src/agent src/harness src/coding-agent
git commit -m "test: enforce unified event lifecycle"
```

---

### Task 6: Update public APIs and progressive documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agent/index.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `tests/import-smoke.test.ts`
- Modify: `src/agent/README.md`
- Modify: `src/harness/README.md`
- Modify: `src/coding-agent/README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: final runtime APIs.
- Produces: complete public inventory and documentation without old Hook/EventBus terminology.

- [ ] **Step 1: Make the public import test describe the final surface**

The root import test must value-import `Events`, `runAgentLoop`, `AgentHarness`, `Session`, `SessionRepository`, `createProject`, and existing Tool/UI public classes. Its type-only assertions must include `EventContract`, `EventMap`, `AgentRunIdentity`, `ToolCallDecision`, `HarnessRunEndInput`, `StreamChunk`, `Project`, and `ToolPresentationInput`. Remove all old Hook and event-union imports.

- [ ] **Step 2: Run typecheck and verify any export gaps**

Run: `npm run typecheck`

Expected: any failure points directly to a missing final export; no compatibility alias should be introduced to satisfy it.

- [ ] **Step 3: Rewrite the Agent README around one Run**

Use this progression:

1. Agent owns one Run.
2. `runAgentLoop()` input and `Promise<void>` output.
3. `AgentContext.appendMessage()` and persistence boundary.
4. Tool lifecycle.
5. Agent-owned EventMap entries grouped into facts, questions, and transformations.
6. Public API inventory and dependencies.

Do not describe historical Hook callbacks except for one migration sentence if necessary.

- [ ] **Step 4: Rewrite the Harness README around one Session**

Explain that Harness creates Run identity, owns cancellation and run boundaries, implements message persistence, and uses the Project-provided `Events`. Teach `EventMap` versus `Events`, then `on / emit / ask / transform`, then show how Session and Run identities let a UI select one Session. State explicitly that Harness has no `subscribe()` and no private EventBus.

- [ ] **Step 5: Rewrite the Coding Agent README around one Project**

Start from the reader's existing Harness knowledge. Explain that Project owns directories, SessionRepository, one shared `Events`, coding Tools, Permission listener, interactions, and tool presentation. Show `project.events.on(...)`, Session creation/opening, and why multiple Sessions share listeners but are distinguished by `sessionId`.

- [ ] **Step 6: Update architecture and run stale scans**

Run:

```powershell
rg -n "HookRegistry|AgentHook|Hook Call|HarnessEvent|HarnessEventBus|liftAgentEvent|harness\.subscribe|AssistantMessageEvent|Event System" src tests docs/architecture.md
```

Expected: no stale source or current-architecture documentation references. Historical specification text may be excluded explicitly by path rather than edited.

- [ ] **Step 7: Run final verification and commit**

Run:

```powershell
npm run test
npm run typecheck
git diff --check
```

Expected: all tests pass, typecheck succeeds, and diff check produces no errors.

```powershell
git add src tests docs
git commit -m "docs: explain the unified event mechanism"
```
