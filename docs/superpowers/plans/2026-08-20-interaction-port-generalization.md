# Interaction Port Generalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the permission-only `Interactions` port into a UI-independent `UserInteraction` port (`select` / `confirm` / `input`), and rewire the Coding Agent Permission logic to consume it. This is **Direction A** only; the event-system restructure (**Direction B**) is a separate plan and is NOT in scope.

**Architecture:** `UserInteraction` is a plain, UI-independent port in `coding-agent` (no terminal import). Permission builds a user-facing prompt and calls `interaction.select(["Allow once", "Always allow", "Deny"])`, mapping the index to the existing `once` / `always` / `deny` reply. `CliInteractions` (in `ui`) implements the port over the readline question function. `main.ts` injects it. `core/harness` is untouched.

**Tech Stack:** Node.js 24, TypeScript 7 NodeNext ESM, `node:test`, existing `Events`/`AgentTool` layers.

## Global Constraints

- Keep the port in `coding-agent`; **do not move it into `core`** (no generic core component asks the user yet). `core/harness` must compile and behave unchanged.
- The port must not import or reference any UI / terminal type.
- Preserve the Permission semantics: hard-deny, remembered `always` rules, `once`, `deny`, fail-closed on interaction error, propagate abort.
- Rename the option/parameter key `interactions` → `interaction` across assembly.
- Drop `Interactions`, `PermissionRequest`, `PermissionReply` from the public port / `coding-agent/index.ts`; keep `PermissionReply` as an internal type inside `permission.ts`.
- Do NOT add `UserInteraction` to `core/harness` `ToolExecutionContext` in this plan (tool access via factory closure binding is a follow-up, not here).
- Do not implement Direction B (event-system split) here.
- Update every affected test so `npm test` passes.

## File Map

**Rewrite:**

- `src/coding-agent/interaction/interactions.ts` — `Interactions.permission` → `UserInteraction.select/confirm/input` + `InteractionOptions`.
- `src/coding-agent/events/permission/permission.ts` — use `UserInteraction.select`; keep `PermissionReply` internal; build prompts instead of `PermissionRequest`.
- `src/ui/cli/cli-interactions.ts` — implement `UserInteraction` (select / confirm / input) over the question function.
- `tests/coding-agent/interaction/interactions.test.ts`
- `tests/coding-agent/events/permission/permission.test.ts`
- `tests/ui/cli/cli-interactions.test.ts`

**Modify:**

- `src/coding-agent/events/factory.ts` — `interactions: Interactions` → `interaction: UserInteraction`.
- `src/coding-agent/factory.ts` — `interactions` → `interaction` (option + pass-through).
- `src/main.ts` — pass `interaction: ui.interactions`.
- `src/coding-agent/index.ts` — export `UserInteraction`, `InteractionOptions`; remove `Interactions`, `PermissionRequest`, `PermissionReply`.
- `tests/coding-agent/events/factory.test.ts`
- `tests/coding-agent/project/factory.test.ts`
- `tests/ui/cli/cli-ui.test.ts`
- `tests/ui/cli/full-composition.test.ts`
- `tests/import-smoke.test.ts`

**Untouched:** all of `src/core/**`, `src/coding-agent/tools/**`, the six built-in tools, and the event system.

## Verification

After all tasks, from the repository root:

```powershell
npm run typecheck
npm test
```

Expected: `tsc --noEmit` exits 0; `node --test` reports all tests passing.

---

### Task 1: Generalize the port interface

**Files:** rewrite `src/coding-agent/interaction/interactions.ts`, rewrite `tests/coding-agent/interaction/interactions.test.ts`.

- [ ] **Step 1: Write failing port tests (new API)**

Replace the old `Interactions.permission` test with one asserting the `UserInteraction` shape and the option-signal passthrough:

```ts
const adapter: UserInteraction = {
  async select(_title, options, opts) { opts?.signal?.throwIfAborted(); return options.length - 1; },
  async confirm(_title, _message, opts) { opts?.signal?.throwIfAborted(); return false; },
  async input(_title, _placeholder, opts) { opts?.signal?.throwIfAborted(); return "text"; },
};
assert.equal(await adapter.select("t", ["a", "b"]), 1);
assert.equal(await adapter.confirm("t", "m"), false);
assert.equal(await adapter.input("t", undefined), "text");
```

- [ ] **Step 2: Compile to verify the new API fails**

Run `npx tsc --noEmit` (or `npm run typecheck`). Expected: FAIL because `UserInteraction` / `InteractionOptions` do not exist.

- [ ] **Step 3: Implement `UserInteraction`**

In `interactions.ts`:

```ts
export interface InteractionOptions {
  readonly signal?: AbortSignal;
}

export interface UserInteraction {
  select(title: string, options: readonly string[], opts?: InteractionOptions): Promise<number | undefined>;
  confirm(title: string, message: string, opts?: InteractionOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: InteractionOptions): Promise<string | undefined>;
}
```

Delete `PermissionRequest`, `PermissionReply`, and the `Interactions` interface from this file.

- [ ] **Step 4: Run the port test and commit**

```powershell
npm run typecheck
node --test "dist/tests/coding-agent/interaction/interactions.test.js"
git add -- src/coding-agent/interaction/interactions.ts tests/coding-agent/interaction/interactions.test.ts
git commit -m "refactor: generalize interaction port to select/confirm/input"
```

---

### Task 2: Rewrite the CLI adapter

**Files:** rewrite `src/ui/cli/cli-interactions.ts`, rewrite `tests/ui/cli/cli-interactions.test.ts`.

- [ ] **Step 1: Write failing adapter tests**

Cover `select` returning the 0-based index (and `undefined` on blank/EOF), `confirm` parsing `y`/`n` (default deny), `input` returning text, and abort propagation via `InteractionOptions.signal`.

- [ ] **Step 2: Compile to verify the adapter fails the new contract**

`npm run typecheck` → FAIL because `CliInteractions` still implements `Interactions.permission`.

- [ ] **Step 3: Implement `CliInteractions`**

Keep the injected `question` function. Implement:
- `select(title, options, opts)` — render `title` + numbered options, read one line, parse a 1-based number to a 0-based index, `undefined` on blank/EOF/invalid.
- `confirm(title, message, opts)` — render `message + " (y/N)"`, treat `y`/`yes` as true, else false.
- `input(title, placeholder, opts)` — render title, return the trimmed answer or `undefined` on blank.
- Preserve the existing abort behavior: on cancel propagate the abort; on ordinary `AbortError` deny/`undefined`.

- [ ] **Step 4: Run adapter tests and commit**

```powershell
npm run typecheck
node --test "dist/tests/ui/cli/cli-interactions.test.js"
git add -- src/ui/cli/cli-interactions.ts tests/ui/cli/cli-interactions.test.ts
git commit -m "refactor: implement UserInteraction in the CLI adapter"
```

---

### Task 3: Rewire Permission onto `select`

**Files:** rewrite `src/coding-agent/events/permission/permission.ts`, rewrite `tests/coding-agent/events/permission/permission.test.ts`.

- [ ] **Step 1: Rewrite failing permission tests**

Replace `RecordingInteractions` with one recording `UserInteraction.select` calls (recording `title` + `options`) and returning a preset index. Preserve all decision scenarios: hard-deny (no interaction), remembered `always`, `once`, out-of-range/undefined index → deny, interaction throw → deny (fail closed) unless aborted. Update the `requests` assertions to assert the `select` title/options and the resulting decision.

- [ ] **Step 2: Compile to verify permission fails the new port**

`npm run typecheck` → FAIL because `permission.ts` still references `Interactions.permission`.

- [ ] **Step 3: Implement the rewrite**

- Keep `PermissionRule`, `remember`, `matchesCommand`, `contains`, `fileTarget`, `staticGlobPrefix`, and `decidePermission` structure unchanged.
- Make `PermissionReply` a private type: `once | always | deny(reason?)`.
- Add `const PERMISSION_OPTIONS = ["Allow once", "Always allow", "Deny"] as const;`
- `ask(interaction, prompt, signal)`: `const index = await interaction.select(prompt, PERMISSION_OPTIONS, { signal })`; map `0 → once`, `1 → always`, else → `deny`. Fail closed (deny) on thrown error unless `signal.aborted`.
- `authorizeDirectory` / `authorizeCommand`: build a `prompt` string (e.g. `\n⚠ ${reason}\n   ${target}\n   Allow?`) instead of a `PermissionRequest`, and call `ask(interaction, prompt, signal)`.
- Rename `options.interactions` → `options.interaction`.

- [ ] **Step 4: Run permission tests and commit**

```powershell
npm run typecheck
node --test "dist/tests/coding-agent/events/permission/permission.test.js"
git add -- src/coding-agent/events/permission/permission.ts tests/coding-agent/events/permission/permission.test.ts
git commit -m "refactor: drive permission through the generalized interaction port"
```

---

### Task 4: Rewire assembly

**Files:** modify `src/coding-agent/events/factory.ts`, `src/coding-agent/factory.ts`, `src/main.ts`, `src/coding-agent/index.ts`.

- [ ] **Step 1: Update `events/factory.ts`** — option `interactions: Interactions` → `interaction: UserInteraction`; pass through to `decidePermission`.
- [ ] **Step 2: Update `coding-agent/factory.ts`** — `openOrCreateProject` option `interactions` → `interaction`; pass to `createBuiltinEvents`.
- [ ] **Step 3: Update `main.ts`** — pass `interaction: ui.interactions`.
- [ ] **Step 4: Update `index.ts`** — export `UserInteraction`, `InteractionOptions`; drop `Interactions`, `PermissionRequest`, `PermissionReply`.
- [ ] **Step 5: Verify and commit**

```powershell
npm run typecheck
git add -- src/coding-agent/events/factory.ts src/coding-agent/factory.ts src/main.ts src/coding-agent/index.ts
git commit -m "refactor: thread the generalized interaction port through assembly"
```

---

### Task 5: Update remaining tests

**Files:** `tests/coding-agent/events/factory.test.ts`, `tests/coding-agent/project/factory.test.ts`, `tests/ui/cli/cli-ui.test.ts`, `tests/ui/cli/full-composition.test.ts`, `tests/import-smoke.test.ts`.

- [ ] **Step 1: Replace every `Interactions`/`permission`/`PermissionRequest`/`PermissionReply` reference with a `UserInteraction` stub** (select returns an index; confirm/input return defaults).
- [ ] **Step 2: Update `import-smoke.test.ts`** — import `UserInteraction` instead of the removed types.
- [ ] **Step 3: Update `cli-ui.test.ts`** — replace `ui.interactions.permission(...)` with `ui.interactions.select(...)` / `confirm(...)`.
- [ ] **Step 4: Run the full suite and commit**

```powershell
npm run typecheck
npm test
git add -- tests
git commit -m "test: adapt interaction tests to the generalized port"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `npm run typecheck` — expect exit 0.
- [ ] **Step 2:** `npm test` — expect all tests pass.
- [ ] **Step 3:** `git status --short` — expect only the plan and this task's files; confirm `src/core/**` untouched.

## Completion Check

- `UserInteraction` (select/confirm/input) is exported from `coding-agent`; `Interactions`/`PermissionRequest`/`PermissionReply` no longer exist in the public API.
- `CliInteractions` implements `UserInteraction`; `main.ts` injects it as `interaction`.
- Permission uses `interaction.select` and preserves once/always/deny + fail-closed + abort behavior.
- `core/harness` compiles and behaves identically; no UI import anywhere in `coding-agent`/`core`.
- `npm run typecheck` and `npm test` pass.
