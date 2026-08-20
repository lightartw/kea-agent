# Direction B — Harness-internal Events (emit) + fixed Hooks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the generic `src/core/events/` dispatcher (emit + intercept + module-augmented `EventMap`). Move observation and control inside `src/core/harness/`: an **emit-only** `HarnessEventBus` for facts and a **fixed set of control `Hooks`**. `AgentHarness` owns both directly — it no longer wraps/projects a shared `Events` or shields `intercept` points. Reference: pi's new harness (`Events` = observation; `Hooks` = fixed enumerated control points).

**Architecture:**

- Observation = `HarnessEventBus` (on / emit, listeners return `void`, per-harness). `AgentHarness` emits `HarnessEvent` directly on its own bus; `subscribe(listener)` becomes a thin pass-through (no session filtering, no projection, no shielding).
- Control = `HarnessHooks` (a few fixed named points). Each hook has a uniform contract:
  - `beforePrompt(prompt, ctx)` → `string | undefined` (was `agent/user-prompt`).
  - `transformContext(messages, ctx)` → `readonly AgentMessage[]` (was `agent/context`).
  - `beforeTool(call, ctx)` → `PreToolDecision` (`{allow} | {deny, reason?}`) (was `tools/pre-execute`; used by Permission).
- Multiple handlers per hook compose via a uniform primitive: transform hooks chain (each sees the previous result); the veto hook `beforeTool` short-circuits on the first `deny`.
- Tool `execute`/`post-execute` interception is dropped: `execute` becomes an internal timeout around the tool body; `post-execute` has no consumer.

**Lifecycle:** per-harness (= per session). Each `AgentHarness` owns one `HarnessEventBus` and one `HarnessHooks`, created on `createHarness()` and discarded with the harness. No project-wide shared `Events`; no cross-session filtering.

**Plugin readiness:** `harness.hooks.on(...)` and `harness.events.on(...)` are the public, stable registration surface. A future plugin loader registers handlers on the same surface; multiple handlers compose via the uniform primitive. Do NOT add a plugin loader now (YAGNI), but keep the registration surface public and documented.

**Tech Stack:** Node.js 24, TypeScript 7 NodeNext ESM, `node:test`, existing `AgentTool`/`AgentToolRegistry`/`Session`.

## Global Constraints

- `core/harness` must not import `core/events`; the whole `src/core/events/` directory is deleted.
- The public `HarnessEvent` shape is preserved (runId, no sessionId) so the `Renderer`/UI is unchanged.
- `AgentHarness` owns one `HarnessEventBus` and one `HarnessHooks`; it no longer receives a shared `Events` in `HarnessConfig`.
- Control points are explicit and enumerated; no generic `intercept`/`EventMap` machinery survives.
- Permission moves from a `tools/pre-execute` listener to a `beforeTool` hook registered on each harness's hooks.
- No behavior change to the Permission decision semantics (allow/ask/deny, remembered rules, fail-closed, abort).
- `AgentTool.execute(args, signal)` signature is unchanged.
- Do not implement Direction A leftovers here (tool closure-bound `UserInteraction` is already done; no further changes).
- Update every affected test so `npm test` passes; delete `tests/events/events.test.ts`.

## File Map

**Delete:**

- `src/core/events/` (events.ts, types.ts, index.ts)
- `tests/events/events.test.ts`
- `src/coding-agent/events/factory.ts` (`createBuiltinEvents` — replaced by a permission-hook factory)

**Create (inside `src/core/harness/`):**

- `src/core/harness/hooks.ts` — `HarnessHooks` registry + fixed hook contracts + `PreToolDecision`.

**Rewrite:**

- `src/core/harness/events.ts` — `HarnessEvent` + `HarnessEventBus` (emit-only); drop `EventMap` augmentation.
- `src/core/harness/types.ts` — `HarnessConfig`/`AgentContext` use harness `Events` + `Hooks`.
- `src/core/harness/agent-harness.ts` — owns `HarnessEventBus` + `HarnessHooks`; `subscribe` is a pass-through; exposes `hooks`.
- `src/core/harness/agent-loop.ts` — `context.events.emit(...)` for facts; `context.hooks.beforePrompt`/`transformContext` for control.
- `src/core/harness/tools/events.ts` — keep `ToolCallEvent`/`ToolResultEvent`; remove `InterceptEvent`/`PreToolDecision` (moved to hooks.ts) and the module augmentation.
- `src/core/harness/tools/types.ts` — `ToolExecutionContext`: replace `events: Events` with `hooks: HarnessHooks`.
- `src/core/harness/tools/registry.ts` — use `context.hooks.beforeTool(...)`; internal timeout; drop `execute`/`post-execute` interception.
- `src/coding-agent/project/project.ts` — drop shared `Events`; hold the permission `beforeTool` handler and register it on each harness.
- `src/coding-agent/factory.ts` — `openOrCreateProject` builds the permission `beforeTool` handler (over `approved`/`interaction`/`trustedDirectories`) and hands it to `Project`.
- `src/index.ts` — remove `export * from "./core/events/index.js"`.

**Tests:**

- Rewrite `tests/harness/control-events.test.ts` → hook-based tests (beforePrompt/transformContext/beforeTool).
- Rewrite `tests/harness/agent-loop.test.ts`, `tests/harness/agent-harness.test.ts`, `tests/harness/tools/registry.test.ts`.
- Rewrite `tests/coding-agent/events/factory.test.ts` → permission-hook test.
- Rewrite `tests/coding-agent/project/project.test.ts`, `tests/coding-agent/tools/factory.test.ts`.
- Update `tests/import-smoke.test.ts` (remove `Events`/`EventMap`).
- UI / renderer / full-composition tests: unchanged if `HarnessEvent` shape is preserved.

## Verification

After all tasks, from the repository root:

```powershell
npm run typecheck
npm test
```

Expected: `tsc --noEmit` exits 0; `node --test` reports all tests passing.

---

### Task 1: Harness event bus (emit-only) and HarnessEvent

**Files:** rewrite `src/core/harness/events.ts`.

- [ ] **Step 1:** Define `HarnessEvent` (preserve current union shape).
- [ ] **Step 2:** Implement `HarnessEventBus` with `on(type, listener)` and `emit(event)`; listeners return `void`; emit isolates listener errors via a reporter. Drop `EventMap` augmentation.
- [ ] **Step 3:** `npm run typecheck` — expect FAIL because `core/events` types are still referenced.

### Task 2: Fixed hooks registry

**Files:** create `src/core/harness/hooks.ts`.

- [ ] **Step 1:** Define `PreToolDecision = { allow } | { deny, reason? }`.
- [ ] **Step 2:** Define hook names and contracts:
  - `beforePrompt(prompt, ctx)` → `string | undefined`
  - `transformContext(messages, ctx)` → `readonly AgentMessage[]`
  - `beforeTool(call, ctx)` → `PreToolDecision | void`
- [ ] **Step 3:** Implement `HarnessHooks.on(name, handler)` with per-hook composition (transform chains; veto first-deny-short-circuits) and a `run` method per hook.
- [ ] **Step 4:** `npm run typecheck`.

### Task 3: AgentHarness owns events + hooks

**Files:** rewrite `src/core/harness/agent-harness.ts`, `src/core/harness/types.ts`.

- [ ] **Step 1:** Remove `events` from `HarnessConfig`; harness creates its own `HarnessEventBus` and `HarnessHooks`.
- [ ] **Step 2:** `prompt()` emits `harness/run-start` / `harness/run-end` on its own bus.
- [ ] **Step 3:** `subscribe(listener)` becomes a pass-through to the harness's own bus (returning unsubscribe); expose `readonly hooks`.
- [ ] **Step 4:** `AgentContext` carries the harness `events` + `hooks`.
- [ ] **Step 5:** `npm run typecheck`.

### Task 4: Agent loop uses emit + hooks

**Files:** rewrite `src/core/harness/agent-loop.ts`.

- [ ] **Step 1:** Replace `context.events.intercept("agent/user-prompt", ...)` with `context.hooks.beforePrompt(...)`.
- [ ] **Step 2:** Replace `context.events.intercept("agent/context", ...)` with `context.hooks.transformContext(...)`.
- [ ] **Step 3:** Keep all `context.events.emit(...)` fact calls unchanged.
- [ ] **Step 4:** `npm run typecheck`.

### Task 5: Tool registry uses the beforeTool hook

**Files:** rewrite `src/core/harness/tools/registry.ts`, `src/core/harness/tools/types.ts`, `src/core/harness/tools/events.ts`.

- [ ] **Step 1:** `ToolExecutionContext`: replace `events` with `hooks: HarnessHooks`.
- [ ] **Step 2:** `execute()` calls `context.hooks.beforeTool(call, ctx)`; on `deny` return an error result.
- [ ] **Step 3:** Wrap tool execution in the internal timeout (no `tools/execute` intercept).
- [ ] **Step 4:** Remove `tools/post-execute` (no consumer) and the `InterceptEvent`/`EventMap` augmentation.
- [ ] **Step 5:** `npm run typecheck`.

### Task 6: Permission → beforeTool hook; project/factory rewire

**Files:** rewrite `src/coding-agent/events/factory.ts` (→ permission-hook factory), `src/coding-agent/project/project.ts`, `src/coding-agent/factory.ts`.

- [ ] **Step 1:** Add `createPermissionHook({ approved, trustedDirectories, interaction })` returning a `beforeTool` handler (calls `decidePermission`; fail-closed).
- [ ] **Step 2:** `openOrCreateProject` builds the handler and passes it to `Project`.
- [ ] **Step 3:** `Project.createHarness()` / `createHarnessFromSession()` register the handler on the harness's `beforeTool` hook.
- [ ] **Step 4:** Remove the shared `Events` from `Project`.
- [ ] **Step 5:** `npm run typecheck`.

### Task 7: Delete core/events

**Files:** delete `src/core/events/`, update `src/index.ts`.

- [ ] **Step 1:** `git rm -r src/core/events`.
- [ ] **Step 2:** Remove `export * from "./core/events/index.js"` from `src/index.ts`.
- [ ] **Step 3:** `npm run typecheck` — expect FAIL only in tests still referencing `core/events`.

### Task 8: Rewrite / delete tests

**Files:** delete `tests/events/events.test.ts`; rewrite `tests/harness/control-events.test.ts`, `tests/harness/agent-loop.test.ts`, `tests/harness/agent-harness.test.ts`, `tests/harness/tools/registry.test.ts`, `tests/coding-agent/events/factory.test.ts`, `tests/coding-agent/project/project.test.ts`, `tests/coding-agent/tools/factory.test.ts`, `tests/import-smoke.test.ts`.

- [ ] **Step 1:** Delete `tests/events/events.test.ts`.
- [ ] **Step 2:** Rewrite control-event tests to drive the `HarnessHooks` (beforePrompt/transformContext/beforeTool) and the harness bus.
- [ ] **Step 3:** Update remaining tests to construct `AgentHarness`/registry with the harness-owned bus + hooks.
- [ ] **Step 4:** `npm test` — all green.

### Task 9: Full verification

- [ ] **Step 1:** `npm run typecheck` — exit 0.
- [ ] **Step 2:** `npm test` — all pass.
- [ ] **Step 3:** `git status --short` — only Direction B files; confirm `src/core/events/` is gone and `core/harness` has no `../events` import.

## Completion Check

- `src/core/events/` deleted; no file imports it.
- `AgentHarness` owns one `HarnessEventBus` + one `HarnessHooks`; `subscribe` is a pass-through.
- Control is a fixed, enumerated set of hooks (`beforePrompt`, `transformContext`, `beforeTool`); no generic `intercept`/`EventMap`.
- Permission is a `beforeTool` hook; semantics unchanged.
- `HarnessEvent` shape preserved → `Renderer`/UI unchanged.
- `npm run typecheck` and `npm test` pass.
