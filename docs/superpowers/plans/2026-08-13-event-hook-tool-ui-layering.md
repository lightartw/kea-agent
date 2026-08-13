# Event, Hook, and Tool UI Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Harness the sole runtime surface, give it a flat contextual event stream, and assemble Agent Tools, Agent Hooks, Coding Tool presentations, and UI interactions without crossing package boundaries.

**Architecture:** Keep execution contracts in `agent`, move Harness into a sibling package, and lift every `AgentEvent` into a flat `HarnessEvent` carrying `lane` and `runId`. Coding Agent is the construction root: one `CodingToolDefinition` is projected down to `AgentTool` and sideways to an optional presentation registry, while user interactions remain a separate injected port. Runtime UI receives `CodingAgentRuntime`, may import the public `HarnessEvent` observation contract, and never imports Agent Tool, Hook, Event, or registry modules.

**Tech Stack:** TypeScript 7, Node.js 24, TypeBox 1.3, `node:test`, ESM with NodeNext resolution.

## Global Constraints

- Preserve the dependency direction `ui -> coding-agent -> harness -> agent -> ai`.
- The first implementation has exactly one lane named `main`; it does not implement background or parallel lanes.
- AI, Agent Loop, Agent Tool, and Agent Hook must not receive `lane` or `runId`.
- Hook Calls are awaited control requests; Event listeners cannot change execution and listener failures are isolated.
- Do not add Harness Hooks or a shared Hook registry core until a real Harness decision point exists.
- Harness exposes one flat `HarnessEvent` stream and does not expose its internal Agent or a second Agent event subscription.
- Do not create `HarnessToolCall` or `HarnessToolResult` aliases while their semantics remain identical to Agent Tool types.
- `AgentToolResult.content` remains model-visible; `details` remains program-visible; any Hook patch changing `details` must provide matching `content`.
- Tool presentation failures fall back to generic text and never alter Agent or Harness state.
- The public runtime API is `createCodingAgent(config): Promise<CodingAgentRuntime>`; remove the old `createHarness` Coding Agent factory export.
- UI may import public Harness observation types because Harness is its runtime control surface; it must not import Agent contracts or Harness construction internals.
- Use `apply_patch` for edits; use native PowerShell `Move-Item` only for the explicit file moves listed below.
- Every task must leave `npm test` passing before commit.

---

## File Structure

```text
src/
  agent/
    index.ts
    agent-loop.ts
    types.ts
    hooks/
    tools/
  harness/
    agent-harness.ts
    types.ts
    system-prompt.ts
    events/
      event-bus.ts
      index.ts
      types.ts
    session/
      manager.ts
      session.ts
      types.ts
  coding-agent/
    factory.ts
    runtime.ts
    types.ts
    hooks/
      factory.ts
      permission.ts
      types.ts
    tools/
      definition.ts
      wrapper.ts
      factory.ts
      bash.ts
      files.ts
      glob.ts
      todo-write.ts
      todo-state.ts
    ui/
      interactions.ts
      presentation-registry.ts
      tool-presentation.ts
  ui/
    index.ts
    cli-frontend.ts
    cli-harness-renderer.ts
    cli-interactions.ts
```

`agent` owns one-run execution, Tool execution contracts, Hook Calls, and Agent facts. `harness` owns session state, accepted runs, `lane/runId`, and the only runtime event stream. `coding-agent` owns construction, Coding Tool definitions, Hook implementations, interaction ports, and tool presentation policy. `ui` owns terminal I/O only.

---

### Task 1: Move Harness into a Sibling Package

**Files:**
- Move: `src/agent/harness/agent-harness.ts` -> `src/harness/agent-harness.ts`
- Move: `src/agent/harness/types.ts` -> `src/harness/types.ts`
- Move: `src/agent/harness/system-prompt.ts` -> `src/harness/system-prompt.ts`
- Move: `src/agent/harness/session/manager.ts` -> `src/harness/session/manager.ts`
- Move: `src/agent/harness/session/session.ts` -> `src/harness/session/session.ts`
- Move: `src/agent/harness/session/types.ts` -> `src/harness/session/types.ts`
- Move: `src/agent/harness/index.ts` -> `src/harness/index.ts`
- Move: `src/agent/harness/README.md` -> `src/harness/README.md`
- Move: `tests/coding-agent/agent-harness.test.ts` -> `tests/harness/agent-harness.test.ts`
- Move: `tests/coding-agent/session.test.ts` -> `tests/harness/session.test.ts`
- Move: `tests/coding-agent/session-manager.test.ts` -> `tests/harness/session-manager.test.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/ui/frontend.ts`
- Modify: `src/main.ts`
- Modify: `src/index.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: Existing `AgentHarness`, `HarnessConfig`, `Session`, and `SessionManager` behavior.
- Produces: The same interfaces from `src/harness/**`, with no forwarding files left under `src/agent/harness`.

- [ ] **Step 1: Point the public import smoke test at the sibling Harness package**

```ts
import {
  AgentHarness,
  Session,
  SessionManager,
  type HarnessConfig,
} from "../src/harness/index.js";
```

Update all test imports in the three moved test files to use `../../src/harness/**` and Agent imports from `../../src/agent/**`.

- [ ] **Step 2: Run the import test to verify the new boundary does not exist yet**

Run: `npm run build`

Expected: FAIL with `TS2307` for `src/harness/index.js`.

- [ ] **Step 3: Move the files and repair only relative imports**

Run these explicit moves from the repository root:

```powershell
New-Item -ItemType Directory -Force src/harness/session, tests/harness | Out-Null
Move-Item src/agent/harness/agent-harness.ts src/harness/agent-harness.ts
Move-Item src/agent/harness/types.ts src/harness/types.ts
Move-Item src/agent/harness/system-prompt.ts src/harness/system-prompt.ts
Move-Item src/agent/harness/index.ts src/harness/index.ts
Move-Item src/agent/harness/README.md src/harness/README.md
Move-Item src/agent/harness/session/manager.ts src/harness/session/manager.ts
Move-Item src/agent/harness/session/session.ts src/harness/session/session.ts
Move-Item src/agent/harness/session/types.ts src/harness/session/types.ts
Move-Item tests/coding-agent/agent-harness.test.ts tests/harness/agent-harness.test.ts
Move-Item tests/coding-agent/session.test.ts tests/harness/session.test.ts
Move-Item tests/coding-agent/session-manager.test.ts tests/harness/session-manager.test.ts
```

Use these import directions in the moved files:

```ts
// src/harness/agent-harness.ts
import { runAgentLoop } from "../agent/agent-loop.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { ModelConfig, StreamFn } from "../ai/types.js";

// src/harness/session/types.ts
import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";
```

Update every source and test import found by:

```powershell
rg -n 'agent/harness' src tests
```

Delete the now-empty `src/agent/harness/session` and `src/agent/harness` directories with non-recursive `Remove-Item` after verifying they contain no files.

- [ ] **Step 4: Verify the move preserved behavior and removed the old boundary**

Run: `npm test`

Expected: PASS, 161 tests or more, 0 failures.

Run: `rg -n 'agent/harness' src tests`

Expected: no matches.

- [ ] **Step 5: Commit**

```powershell
git add src tests
git commit -m "refactor: move harness into sibling package"
```

---

### Task 2: Add the Flat Harness Event Stream

**Files:**
- Create: `src/harness/events/types.ts`
- Create: `src/harness/events/event-bus.ts`
- Create: `src/harness/events/index.ts`
- Create: `tests/harness/events.test.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/harness/agent-harness.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/ui/harness-renderer.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/ui/harness-renderer.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` from `src/agent/types.ts` and the existing `AgentHarness.prompt()` lifecycle.
- Produces: `HarnessEvent`, `HarnessToolEvent`, `HarnessListener`, `liftAgentEvent()`, `HarnessEventBus`, `MAIN_LANE`, and run lifecycle events.

- [ ] **Step 1: Write failing type and lifecycle tests**

Add `tests/harness/events.test.ts` with these assertions:

```ts
test("liftAgentEvent keeps the flat discriminant and adds run identity", () => {
  assert.deepEqual(
    liftAgentEvent(
      { type: "text_delta", text: "hello" },
      { lane: "main", runId: "run-1" },
    ),
    { type: "text_delta", text: "hello", lane: "main", runId: "run-1" },
  );
});

test("event bus snapshots listeners and isolates failures", async () => {
  const errors: unknown[] = [];
  const bus = new HarnessEventBus((error) => errors.push(error));
  const calls: string[] = [];
  bus.subscribe(() => { calls.push("first"); throw new Error("listener failed"); });
  bus.subscribe(() => { calls.push("second"); });
  await bus.publish({ type: "run_start", lane: "main", runId: "run-1" });
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal((errors[0] as Error).message, "listener failed");
});
```

Extend `tests/harness/agent-harness.test.ts` to assert:

```ts
assert.equal(events[0]?.type, "run_start");
assert.equal(events.at(-1)?.type, "run_end");
assert.ok(events.every((event) => event.lane === "main"));
assert.equal(new Set(events.map((event) => event.runId)).size, 1);
assert.notEqual(firstRunId, secondRunId);
```

Add one listener that throws and verify `prompt()` still resolves and the next listener still receives `run_end`. Replace the old test that expected subscriber failure to reject `prompt()`.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm run build && node --test dist/tests/harness/events.test.js dist/tests/harness/agent-harness.test.js`

Expected: FAIL because the Harness event types and bus do not exist and Harness still emits bare `AgentEvent`.

- [ ] **Step 3: Define the exact event contracts**

Create `src/harness/events/types.ts`:

```ts
import type { AgentEvent } from "../../agent/types.js";

export const MAIN_LANE = "main";

export interface HarnessEventContext {
  readonly lane: string;
  readonly runId: string;
}

export type LiftAgentEvent<E extends AgentEvent = AgentEvent> =
  E extends AgentEvent ? E & HarnessEventContext : never;

export type HarnessRunEndEvent =
  | (HarnessEventContext & { readonly type: "run_end"; readonly reason: "completed" | "aborted" })
  | (HarnessEventContext & { readonly type: "run_end"; readonly reason: "error"; readonly errorMessage: string });

export type HarnessOwnedEvent =
  | (HarnessEventContext & { readonly type: "run_start" })
  | HarnessRunEndEvent;

export type HarnessEvent = LiftAgentEvent | HarnessOwnedEvent;

export type HarnessToolEvent = Extract<
  HarnessEvent,
  { readonly type: "tool_start" | "tool_end" | "tool_rejected" }
>;

export type HarnessListener = (
  event: HarnessEvent,
) => void | Promise<void>;

export type HarnessListenerErrorHandler = (
  error: unknown,
  event: HarnessEvent,
) => void;

export type Unsubscribe = () => void;

export function liftAgentEvent<E extends AgentEvent>(
  event: E,
  context: HarnessEventContext,
): LiftAgentEvent<E> {
  return { ...event, ...context } as LiftAgentEvent<E>;
}
```

- [ ] **Step 4: Implement an isolated, snapshot-based Event bus**

Create `src/harness/events/event-bus.ts`:

```ts
import type {
  HarnessEvent,
  HarnessListener,
  HarnessListenerErrorHandler,
  Unsubscribe,
} from "./types.js";

export class HarnessEventBus {
  private readonly listeners = new Set<HarnessListener>();

  constructor(
    private readonly onListenerError: HarnessListenerErrorHandler = () => undefined,
  ) {}

  subscribe(listener: HarnessListener): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  async publish(event: HarnessEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        try { this.onListenerError(error, event); } catch { /* error reporting is isolated too */ }
      }
    }
  }
}
```

Export these contracts from `src/harness/events/index.ts` and `src/harness/index.ts`. Move `HarnessListener` and `Unsubscribe` out of `src/harness/types.ts`; add this optional neutral diagnostic seam to `HarnessConfig`:

```ts
readonly onEventListenerError?: HarnessListenerErrorHandler;
```

- [ ] **Step 5: Make AgentHarness own run identity and publish only HarnessEvent**

In `src/harness/agent-harness.ts`, replace the listener set with a `HarnessEventBus`, generate a fresh `randomUUID()` after `assertIdle()`, and use one context for the full prompt:

```ts
const eventContext = { lane: MAIN_LANE, runId: randomUUID() };
await this.events.publish({ type: "run_start", ...eventContext });

for await (const event of this.runPrompt(input)) {
  await this.persistNewMessages();
  await this.events.publish(liftAgentEvent(event, eventContext));
}
```

Capture the prompt outcome, finish persistence and set `running = false` before publishing `run_end`. Publish exactly one terminal event:

```ts
const endEvent: HarnessRunEndEvent = failure === undefined
  ? { type: "run_end", ...eventContext, reason: this.abortRequested ? "aborted" : "completed" }
  : { type: "run_end", ...eventContext, reason: "error", errorMessage: errorMessage(failure) };
await this.events.publish(endEvent);
if (failure !== undefined) throw failure;
```

Keep `runPrompt()` private and typed as `AsyncIterable<AgentEvent>`; this is the only point where raw Agent facts exist inside Harness. `subscribe()` delegates to `this.events.subscribe()`.

Update the current `CliHarnessRenderer.render()` parameter from `AgentEvent` to `HarnessEvent` and add `run_start`/`run_end` to its no-output cases. This is a temporary consumer repair; Task 7 moves the renderer into its final file and changes its Tool presentation dependency.

- [ ] **Step 6: Run focused and full verification**

Run: `npm run build && node --test dist/tests/harness/events.test.js dist/tests/harness/agent-harness.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add src/harness tests/harness
git commit -m "feat: add flat harness event stream"
```

---

### Task 3: Replace CodingHookUI with CodingAgentInteractions

**Files:**
- Create: `src/coding-agent/ui/interactions.ts`
- Modify: `src/coding-agent/hooks/types.ts`
- Modify: `src/coding-agent/hooks/permission.ts`
- Modify: `src/coding-agent/hooks/factory.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/ui/frontend.ts`
- Modify: `tests/coding-agent/hooks/defaults.test.ts`
- Modify: `tests/coding-agent/hooks/permission.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/ui/frontend.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: Existing permission Hook and its `confirm`/`notify` behavior.
- Produces: `CodingAgentInteractions`, `ConfirmationRequest`, `Notification`, `NO_INTERACTIONS`, and `CodingHookContext.interactions`.

- [ ] **Step 1: Change tests to the interaction terminology**

Update test doubles to implement:

```ts
const interactions: CodingAgentInteractions = {
  available: true,
  async confirm(request) {
    confirmations.push(request.source);
    return true;
  },
  notify(notification) {
    notifications.push(notification);
  },
};
```

Factory tests must pass `interactions`, not `ui`; Hook context assertions must read `context.interactions`.

- [ ] **Step 2: Run the focused tests to verify the public rename fails**

Run: `npm run build && node --test dist/tests/coding-agent/hooks/*.test.js dist/tests/coding-agent/factory.test.js dist/tests/ui/frontend.test.js`

Expected: FAIL with missing `CodingAgentInteractions` and obsolete `ui` properties.

- [ ] **Step 3: Define the interaction port independently of Hooks**

Create `src/coding-agent/ui/interactions.ts`:

```ts
export interface ConfirmationRequest {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

export interface Notification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface CodingAgentInteractions {
  readonly available: boolean;
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}

export const NO_INTERACTIONS: CodingAgentInteractions = Object.freeze({
  available: false,
  async confirm() { return false; },
  notify() { return undefined; },
});
```

Keep only Hook-specific context in `src/coding-agent/hooks/types.ts`:

```ts
export interface CodingHookContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}

export type CodingHookRegistry = HookRegistry<CodingHookContext>;
```

- [ ] **Step 4: Rewire permission, factory, and frontend**

Replace `context.ui` with `context.interactions`, `config.ui` with `config.interactions`, and `NO_HOOK_UI` with `NO_INTERACTIONS`. `CliFrontend` temporarily implements `CodingAgentInteractions`; Task 7 extracts the concrete adapter.

The permission branch remains fail-closed:

```ts
if (!context.interactions.available) {
  return { block: true, reason: `${decision.reason}; no confirmation UI available` };
}
const allowed = await context.interactions.confirm(request, signal);
```

Remove every exported symbol named `CodingHookUI`, `HookConfirmation`, `HookNotification`, and `NO_HOOK_UI`.

- [ ] **Step 5: Verify the rename and dependency boundary**

Run: `npm test`

Expected: PASS with 0 failures.

Run: `rg -n 'CodingHookUI|HookConfirmation|HookNotification|NO_HOOK_UI|context\.ui|config\.ui' src tests`

Expected: no matches.

- [ ] **Step 6: Commit**

```powershell
git add src/coding-agent src/ui tests
git commit -m "refactor: define coding agent interactions"
```

---

### Task 4: Move Tool Presentation Policy into Coding Agent

**Files:**
- Create: `src/coding-agent/ui/tool-presentation.ts`
- Create: `src/coding-agent/ui/presentation-registry.ts`
- Create: `tests/coding-agent/ui/presentation-registry.test.ts`
- Modify: `src/coding-agent/index.ts`

**Interfaces:**
- Consumes: `HarnessToolEvent`, `AgentToolCall`, `AgentToolResult`, and `ToolRejectedReason`.
- Produces: `CodingToolPresentation`, `ToolPresentationCall`, `ToolPresentationRejected`, and `CodingToolPresentationRegistry.render(event)`.

- [ ] **Step 1: Write failing registry tests against HarnessToolEvent**

Create tests for specialized rendering, missing presentation fallback, `undefined` fallback, thrown-renderer isolation, rejected rendering, and duplicate registration:

```ts
const registry = new CodingToolPresentationRegistry((error) => errors.push(error));
registry.register("todo_write", {
  renderStart: () => "todo start",
  renderEnd: () => "todo end",
  renderRejected: () => "todo rejected",
});

assert.equal(registry.render({
  type: "tool_end",
  lane: "main",
  runId: "run-1",
  call: todoCall,
  result: { content: "ok", isError: false },
}), "todo end");
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run build && node --test dist/tests/coding-agent/ui/presentation-registry.test.js`

Expected: FAIL because the Coding Agent presentation modules do not exist.

- [ ] **Step 3: Define presentation contracts**

Create `src/coding-agent/ui/tool-presentation.ts`:

```ts
import type { AgentToolCall, AgentToolResult } from "../../agent/tools/types.js";
import type { ToolRejectedReason } from "../../agent/types.js";

export type ToolPresentationOutput = string;

export type ToolPresentationCall<TArguments> =
  Omit<AgentToolCall, "arguments"> & { readonly arguments: TArguments };

export interface ToolPresentationRejected<TArguments> {
  readonly call: ToolPresentationCall<TArguments>;
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult<unknown>;
  readonly reason: ToolRejectedReason;
}

export interface CodingToolPresentation<TArguments, TDetails> {
  renderStart(call: ToolPresentationCall<TArguments>): ToolPresentationOutput | undefined;
  renderEnd(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): ToolPresentationOutput | undefined;
  renderRejected?(
    event: ToolPresentationRejected<TArguments>,
  ): ToolPresentationOutput | undefined;
}
```

- [ ] **Step 4: Implement one event-based presentation registry**

`CodingToolPresentationRegistry` stores presentations by tool name, accepts only `HarnessToolEvent`, catches presentation errors, and chooses these fallbacks:

```ts
tool_start:    `[exec] ${name}: ${JSON.stringify(arguments)}`
tool_end ok:   `[done] ${name}: ${content}`
tool_end error:`[error] ${name}: ${content}`
tool_rejected: `[rejected:${reason}] ${name}: ${content}`
```

Use one public method:

```ts
render(event: HarnessToolEvent): string;
```

The internal erased map may use `CodingToolPresentation<unknown, unknown>` with a single checked cast at registration; do not expose erased types publicly.

- [ ] **Step 5: Verify presentation behavior**

Run: `npm run build && node --test dist/tests/coding-agent/ui/presentation-registry.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 6: Commit**

```powershell
git add src/coding-agent/ui src/coding-agent/index.ts tests/coding-agent/ui
git commit -m "feat: add coding tool presentation registry"
```

---

### Task 5: Define Coding Tools Once and Project Them to Agent Tools

**Files:**
- Create: `src/coding-agent/tools/definition.ts`
- Create: `src/coding-agent/tools/wrapper.ts`
- Create: `tests/coding-agent/tools/wrapper.test.ts`
- Modify: `src/coding-agent/tools/bash.ts`
- Modify: `src/coding-agent/tools/files.ts`
- Modify: `src/coding-agent/tools/glob.ts`
- Modify: `src/coding-agent/tools/todo-write.ts`
- Modify: `src/coding-agent/tools/factory.ts`
- Modify: `src/coding-agent/tools/index.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `tests/coding-agent/tools/bash.test.ts`
- Modify: `tests/coding-agent/tools/files.test.ts`
- Modify: `tests/coding-agent/tools/todo-write.test.ts`
- Modify: `tests/coding-agent/tools/factory.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `AgentToolResult`, `CodingToolPresentation`, and `CodingToolContext.cwd`.
- Produces: `CodingToolDefinition`, `toAgentTool()`, and `createDefaultToolDefinitions()`.

- [ ] **Step 1: Write failing definition and projection tests**

Create `tests/coding-agent/tools/wrapper.test.ts`:

```ts
const definition: CodingToolDefinition<typeof parameters, { value: number }> = {
  name: "sample",
  description: "Sample tool",
  parameters,
  async execute(arguments_, _signal, context) {
    return {
      content: `${context.cwd}:${arguments_.value}`,
      details: { value: arguments_.value },
      isError: false,
    };
  },
  presentation: {
    renderStart: () => "start",
    renderEnd: () => "end",
  },
};

const tool = toAgentTool(definition, { cwd: "C:/work" });
assert.equal(Object.hasOwn(tool, "presentation"), false);
assert.deepEqual(
  await tool.execute({ value: 2 }, new AbortController().signal),
  { content: "C:/work:2", details: { value: 2 }, isError: false },
);
```

Change built-in tests to call `definition.execute(args, signal, { cwd })` and assert the default definitions have the six existing names.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npm run build && node --test dist/tests/coding-agent/tools/*.test.js`

Expected: FAIL because `CodingToolDefinition` and `toAgentTool()` do not exist and built-ins are still AgentTool subclasses.

- [ ] **Step 3: Define the Coding Tool contract and Adapter**

Create `src/coding-agent/tools/definition.ts`:

```ts
import type { Static, TObject } from "typebox";
import type { AgentToolResult } from "../../agent/tools/types.js";
import type { CodingToolPresentation } from "../ui/tool-presentation.js";

export interface CodingToolContext {
  readonly cwd: string;
}

export interface CodingToolDefinition<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
    context: CodingToolContext,
  ): Promise<AgentToolResult<TDetails>>;
  readonly presentation?: CodingToolPresentation<Static<TParameters>, TDetails>;
}
```

Create `src/coding-agent/tools/wrapper.ts` with a private `CodingAgentToolAdapter` subclass of `AgentTool`. Its `execute()` delegates to the definition with the captured context. Export only:

```ts
export function toAgentTool<TParameters extends TObject, TDetails>(
  definition: CodingToolDefinition<TParameters, TDetails>,
  context: CodingToolContext,
): AgentTool<TParameters, TDetails>;
```

- [ ] **Step 4: Convert built-ins from classes to definition factories**

Export these exact constructors:

```ts
createBashToolDefinition(ops?: BashOperations): CodingToolDefinition
createReadFileToolDefinition(): CodingToolDefinition
createWriteFileToolDefinition(): CodingToolDefinition
createEditFileToolDefinition(): CodingToolDefinition
createGlobToolDefinition(): CodingToolDefinition
createTodoWriteToolDefinition(): CodingToolDefinition<typeof parameters, TodoDetails>
```

File and shell implementations read the workspace from `context.cwd`; resolve the Coding Tool context once in the factory. Preserve all current output, validation schemas, Bash policy, and error behavior.

Move Todo rendering into `createTodoWriteToolDefinition().presentation`:

```ts
presentation: {
  renderStart() { return undefined; },
  renderEnd(_call, result) {
    if (!isTodoDetails(result.details)) return undefined;
    return result.details.todos
      .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
      .join("\n");
  },
},
```

The old CLI Todo renderer remains temporarily so the pre-runtime CLI stays buildable in this intermediate commit. Task 7 deletes it together with the old CLI Tool renderer registry after the frontend consumes Coding Agent presentations.

- [ ] **Step 5: Make the tool factory return definitions, not an Agent registry**

Replace `createToolRegistry(cwd)` with:

```ts
export function createDefaultToolDefinitions(): readonly CodingToolDefinition[] {
  return [
    createBashToolDefinition(),
    createReadFileToolDefinition(),
    createWriteFileToolDefinition(),
    createEditFileToolDefinition(),
    createGlobToolDefinition(),
    createTodoWriteToolDefinition(),
  ];
}
```

The Tool factory returns definitions only; it does not know Agent registries. To keep the current `createHarness()` API working until Task 6, update `src/coding-agent/factory.ts` to build a local `AgentToolRegistry`, project every definition with `toAgentTool(definition, { cwd })`, and pass that registry to Harness. It deliberately ignores `definition.presentation` for this one intermediate commit; Task 6 assembles both projections and returns them together.

- [ ] **Step 6: Verify execution and presentation projection**

Run: `npm run build && node --test dist/tests/coding-agent/tools/*.test.js dist/tests/coding-agent/ui/presentation-registry.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add src/coding-agent/tools src/coding-agent/ui src/ui tests/coding-agent tests/ui
git commit -m "refactor: define coding tools with presentation"
```

---

### Task 6: Assemble and Return CodingAgentRuntime

**Files:**
- Create: `src/coding-agent/runtime.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `src/main.ts`
- Modify: `src/ui/frontend.ts`
- Modify: `src/ui/harness-renderer.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/ui/frontend.test.ts`
- Modify: `tests/ui/harness-renderer.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: `AgentHarness`, `AgentToolRegistry`, `HookRegistry`, `CodingToolDefinition`, `toAgentTool()`, `CodingToolPresentationRegistry`, and `CodingAgentInteractions`.
- Produces: `CodingAgentRuntime`, `CreateCodingAgentConfig`, and `createCodingAgent()`.

- [ ] **Step 1: Change factory tests to require one runtime object**

Replace factory use with:

```ts
const runtime = await createCodingAgent({
  project,
  streamFn,
  model,
  session: Session.inMemory(),
  interactions,
});

await runtime.harness.prompt("hello");
assert.equal(
  runtime.presentations.render(todoEndEvent),
  "1. [in_progress] Design UI",
);
```

Add a test asserting two factory calls return distinct Harness and Presentation registry instances. Give them different interaction fakes, run the same permission-gated command, and verify each run contacts only its own interaction fake; internal Hook and Agent Tool registries remain private and are tested through behavior, not exposed for identity assertions.

- [ ] **Step 2: Run factory tests to verify the runtime API fails**

Run: `npm run build && node --test dist/tests/coding-agent/factory.test.js dist/tests/import-smoke.test.js`

Expected: FAIL because `createCodingAgent` and `CodingAgentRuntime` do not exist.

- [ ] **Step 3: Define the runtime and construction config**

Create `src/coding-agent/runtime.ts`:

```ts
import type { AgentHarness } from "../harness/agent-harness.js";
import type { CodingToolPresentationRegistry } from "./ui/presentation-registry.js";

export interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}
```

Rename `CreateHarnessConfig` to `CreateCodingAgentConfig` and expose:

```ts
export interface CreateCodingAgentConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}
```

Keep `session` required in the TypeScript type; retain the runtime guard so JavaScript callers receive `session is required` instead of a property crash.

- [ ] **Step 4: Implement the composition root in one direction**

Implement `createCodingAgent()` in this order:

```ts
const context: CodingToolContext = { cwd: config.project.workDir };
const interactions = config.interactions ?? NO_INTERACTIONS;
const definitions = createDefaultToolDefinitions();
const tools = new AgentToolRegistry();
const presentations = new CodingToolPresentationRegistry(
  (error) => {
    try {
      void Promise.resolve(interactions.notify({
        source: "tool-presentation",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      })).catch(() => undefined);
    } catch {
      // Presentation diagnostics must not re-enter execution.
    }
  },
);

for (const definition of definitions) {
  tools.register(toAgentTool(definition, context));
  if (definition.presentation !== undefined) {
    presentations.register(definition.name, definition.presentation);
  }
}

const hooks = createCodingHookRegistry({
  cwd: context.cwd,
  interactions,
});
const harness = new AgentHarness({
  session: config.session,
  model: config.model,
  streamFn: config.streamFn,
  toolRegistry: tools,
  systemPrompt: resolveSystemPrompt(config.systemPrompt),
  cwd: context.cwd,
  hooks,
  onEventListenerError: config.onEventListenerError,
});
return { harness, presentations };
```

Avoid passing an explicit `undefined` optional property under `exactOptionalPropertyTypes`; conditionally spread `onEventListenerError` when it exists. Remove `createHarness` and `createToolRegistry` from Coding Agent public exports.

Repair the current CLI consumer in the same commit: change `CliHarnessRenderer` to accept `CodingToolPresentationRegistry` and call its single `render(event)` method for tool facts. Change `CliFrontend.run()` to accept `CodingAgentRuntime`, use `runtime.harness` for subscribe/prompt/abort, and pass `runtime.presentations` to the renderer. Update `src/main.ts` and their tests to create and pass a runtime. The old `tool-renderers.ts` and `todo-renderer.ts` are now unused but stay for one commit so Task 7 can delete them with their tests while performing the final UI file split.

- [ ] **Step 5: Verify factory ownership and public API**

Run: `npm run build && node --test dist/tests/coding-agent/factory.test.js dist/tests/import-smoke.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 6: Commit**

```powershell
git add src/coding-agent tests/coding-agent tests/import-smoke.test.ts
git commit -m "feat: assemble coding agent runtime"
```

---

### Task 7: Make CLI Consume Only the Coding Agent Runtime

**Files:**
- Create: `src/ui/cli-interactions.ts`
- Create: `src/ui/cli-harness-renderer.ts`
- Create: `src/ui/cli-frontend.ts`
- Modify: `src/main.ts`
- Move: `tests/ui/frontend.test.ts` -> `tests/ui/cli-frontend.test.ts`
- Move: `tests/ui/harness-renderer.test.ts` -> `tests/ui/cli-harness-renderer.test.ts`
- Create: `tests/ui/cli-interactions.test.ts`
- Modify: `tests/main.test.ts`
- Delete: `src/ui/frontend.ts`
- Delete: `src/ui/harness-renderer.ts`
- Delete: `src/ui/tool-renderers.ts`
- Delete: `src/ui/todo-renderer.ts`
- Delete: `tests/ui/tool-renderers.test.ts`
- Delete: `tests/ui/todo-renderer.test.ts`

**Interfaces:**
- Consumes: `CodingAgentRuntime`, `CodingAgentInteractions`, `HarnessEvent`, and `CodingToolPresentationRegistry`.
- Produces: `CliInteractions`, `CliHarnessRenderer`, and `CliFrontend` without imports from `src/agent/**`.

- [ ] **Step 1: Rewrite UI tests around runtime, HarnessEvent, and the interaction adapter**

`CliHarnessRenderer` tests pass contextual events and the Coding Agent registry:

```ts
renderer.render({
  type: "tool_end",
  lane: "main",
  runId: "run-1",
  call,
  result: { content: "ok", isError: false },
});
```

`CliFrontend` tests use a fake `CodingAgentRuntime`:

```ts
const runtime = {
  harness: fakeHarness,
  presentations: new CodingToolPresentationRegistry(),
} as CodingAgentRuntime;
await frontend.run(runtime);
```

Move all confirmation, notification, and ESC-during-confirm tests into `cli-interactions.test.ts`.

- [ ] **Step 2: Run the UI tests to verify the final file split fails**

Run: `npm run build && node --test dist/tests/ui/*.test.js dist/tests/main.test.js`

Expected: FAIL because the three final CLI modules do not exist; the temporary frontend already accepts `CodingAgentRuntime` from Task 6.

- [ ] **Step 3: Extract CliInteractions as the only concrete input adapter**

`CliInteractions` implements `CodingAgentInteractions`, owns confirmation/notification I/O, and provides one CLI-only lifecycle method:

```ts
bindRunAbort(abort: () => void): () => void;
```

`bindRunAbort()` installs the ESC listener and returns an idempotent unbind function. `confirm()` temporarily removes that listener, installs its own ESC cancellation listener, then restores the run listener in `finally`. Preserve the existing `AbortSignal.any`, raw-mode cleanup, fail-to-false AbortError behavior, and notification output.

- [ ] **Step 4: Make CliHarnessRenderer consume HarnessEvent and Coding presentation**

The renderer constructor becomes:

```ts
constructor(
  private readonly target: CliRenderTarget,
  private readonly presentations: CodingToolPresentationRegistry,
) {}
```

Its `render(event: HarnessEvent)` delegates `tool_start`, `tool_end`, and `tool_rejected` to `presentations.render(event)`. Keep text/thinking output, large-output warnings, and Agent end tool-count summary. Treat `run_start` and `run_end` as no-output events in the first CLI.

- [ ] **Step 5: Make CliFrontend orchestrate one runtime**

`CliFrontend` owns one `CliInteractions` instance and exposes it before runtime construction:

```ts
get interactions(): CodingAgentInteractions;
async run(runtime: CodingAgentRuntime): Promise<void>;
```

The getter returns the same `CliInteractions` instance for factory injection. `run()` subscribes only to `runtime.harness`, passes every Event to `CliHarnessRenderer`, binds ESC to `runtime.harness.abort()`, and sends prompts through `runtime.harness.prompt(query)`. It never imports `AgentEvent`, `AgentTool`, `AgentHook`, or Agent registries.

Update `src/main.ts`:

```ts
const frontend = new CliFrontend();
const runtime = await createCodingAgent({
  project,
  streamFn,
  model,
  session,
  interactions: frontend.interactions,
});
await frontend.run(runtime);
```

- [ ] **Step 6: Verify UI behavior and strict dependency direction**

Run: `npm run build && node --test dist/tests/ui/*.test.js dist/tests/main.test.js`

Expected: PASS.

Run: `rg -n 'from "\.\./agent' src/ui`

Expected: no matches; UI may import `HarnessEvent`, but it does not import Agent contracts.

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add src/ui src/main.ts tests/ui tests/main.test.ts
git commit -m "refactor: drive cli through coding agent runtime"
```

---

### Task 8: Align Public Exports and Package Documentation

**Files:**
- Create: `src/agent/index.ts`
- Create: `src/ui/index.ts`
- Modify: `src/index.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/hooks/types.ts`
- Modify: `src/agent/README.md`
- Modify: `src/harness/README.md`
- Modify: `src/coding-agent/README.md`
- Modify: `README.md`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: Final Agent, Harness, Coding Agent, and UI package boundaries.
- Produces: A complete public export surface and READMEs that describe only implemented behavior.

- [ ] **Step 1: Make import-smoke enumerate the final public surface**

The test must import and reference these runtime values from their owning package indexes:

```ts
runAgentLoop;
AgentTool;
AgentToolRegistry;
HookRegistry;
AgentHarness;
Session;
SessionManager;
MAIN_LANE;
createCodingAgent;
CodingToolPresentationRegistry;
CliFrontend;
```

It must also type-check these type-only exports:

```ts
AgentEvent;
AgentHookCall;
AgentToolCall;
AgentToolResult;
HarnessEvent;
HarnessToolEvent;
HarnessConfig;
CodingAgentRuntime;
CreateCodingAgentConfig;
CodingAgentInteractions;
CodingToolDefinition;
CodingToolPresentation;
```

- [ ] **Step 2: Run the import smoke test and record any missing exports**

Run: `npm run build && node --test dist/tests/import-smoke.test.js`

Expected: FAIL only for final symbols not yet exported from their owning indexes.

- [ ] **Step 3: Export each symbol from exactly one owning package**

Use these ownership rules:

```text
agent/index or root agent exports: Agent Loop, Agent Event, Agent Tool, Agent Hook
harness/index: AgentHarness, Harness Event, Session, system prompt contracts
coding-agent/index: factory, runtime, Coding Tool, presentation, interactions, Todo details
ui files: concrete CLI adapters only
```

Create `src/agent/index.ts` to aggregate `agent-loop.ts`, `types.ts`, `tools/index.ts`, and `hooks/index.ts`. Create `src/ui/index.ts` to export only `CliFrontend`, `CliHarnessRenderer`, and `CliInteractions`. `src/index.ts` aggregates `ai/index.ts`, `agent/index.ts`, `harness/index.ts`, `coding-agent/index.ts`, and `ui/index.ts`, while preserving the existing public timeout/workspace utility exports; no lower package re-exports an upper package. Remove obsolete exports for `createHarness`, `createToolRegistry`, `CodingHookUI`, and `CliToolRendererRegistry`.

Change stale Agent comments from “Hook events” and “Handler / Observer” to “Hook Calls” and “Handler / Lifecycle”. These are documentation-only terminology fixes; the existing `HookRegistry` behavior stays unchanged.

- [ ] **Step 4: Rewrite package READMEs around use, concepts, and complete interfaces**

For each README, use this order:

```text
1. One minimal usage example
2. Package responsibility
3. Main internal modules
4. Complete exported values and types
5. Dependencies and package boundary
```

Document these distinctions explicitly:

- Agent Hook Call asks for a decision; Agent Event reports a fact.
- Harness is the runtime superset and emits the sole flat event stream.
- `main` is the only implemented lane; other lanes are not claimed as features.
- Coding Agent directly knows Agent Tool and Agent Hook contracts during construction, while runtime UI knows only `CodingAgentRuntime`.
- Coding Tool presentation and user interactions are separate UI seams.
- `AgentToolCall` and `AgentToolResult` remain Agent-owned data contracts used by Coding Agent presentation; no Harness aliases exist.

Do not document Harness compaction/navigation Hooks, parallel lanes, TUI/Web presentation models, ExtensionHost, snapshot/watch, or other deferred features as implemented.

- [ ] **Step 5: Verify exports, documentation claims, and all behavior**

Run: `rg -n 'createHarness|createToolRegistry|CodingHookUI|CliToolRendererRegistry|agent/harness|research lane|review lane' README.md src tests`

Expected: no stale API or old path matches. A mention in migration history is not needed and should be removed.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `npm test`

Expected: PASS with 0 failures.

- [ ] **Step 6: Commit**

```powershell
git add README.md src tests/import-smoke.test.ts
git commit -m "docs: explain final package boundaries"
```

---

## Final Verification

- [ ] Run `npm test` and confirm every test passes with 0 failures.
- [ ] Run `npm run typecheck` and confirm TypeScript reports 0 errors.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run `git status --short` and confirm only intentionally uncommitted plan-tracking edits remain.
- [ ] Inspect `git log --oneline -8` and verify one focused commit exists for each task.
- [ ] Verify `src/agent` and `src/harness` are sibling directories.
- [ ] Verify `src/ui` contains no imports from `src/agent`; Harness imports are limited to public runtime observation types such as `HarnessEvent`.
- [ ] Verify runtime UI subscribes once, through `runtime.harness.subscribe()`.
- [ ] Verify every lifted Agent Event carries `lane="main"` and one run-scoped `runId`.
- [ ] Verify different calls to `prompt()` receive different `runId` values.
- [ ] Verify a throwing Event listener cannot reject `prompt()` or suppress later listeners.
- [ ] Verify `toAgentTool()` exposes no presentation property.
- [ ] Verify Todo presentation comes from its `CodingToolDefinition`, not the CLI package.
- [ ] Verify permission confirmation uses only `CodingAgentInteractions`.
