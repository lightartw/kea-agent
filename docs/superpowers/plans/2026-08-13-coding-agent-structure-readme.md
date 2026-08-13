# Coding Agent Structure and README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Coding Agent's reusable Tool, Hook, and UI contracts from Kea's built-in implementations, clarify Tool state lifetimes, and rewrite the package README progressively.

**Architecture:** Keep package behavior unchanged. Shared contracts stay at each feature root; Kea-provided tools and hooks move under `builtin/`; UI seams split into `interactions/` and `presentation/`. Deep paths are internal, while `src/coding-agent/index.ts` remains the stable public entry.

**Tech Stack:** TypeScript 7, Node.js 24, TypeBox, Node test runner, Markdown

## Global Constraints

- Do not add a `ToolState`, ExtensionHost, plugin system, renderer tree, or new runtime behavior.
- Do not keep forwarding files at old deep paths.
- Rename `createCodingHookRegistry` to `createDefaultCodingHookRegistry` without a compatibility alias.
- Tool instances must not acquire hidden Session-scoped state.
- Use `apply_patch` for content changes and explicit PowerShell `Move-Item` calls only for the listed file moves.
- Preserve root public exports except for the approved Hook factory rename.

---

### Task 1: Separate the Hook contract from built-in Hooks

**Files:**
- Move: `src/coding-agent/hooks/factory.ts` → `src/coding-agent/hooks/builtin/factory.ts`
- Move: `src/coding-agent/hooks/permission.ts` → `src/coding-agent/hooks/builtin/permission.ts`
- Modify: `src/coding-agent/hooks/types.ts`
- Modify: `src/coding-agent/hooks/index.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/index.ts`
- Move: `tests/coding-agent/hooks/defaults.test.ts` → `tests/coding-agent/hooks/builtin/factory.test.ts`
- Move: `tests/coding-agent/hooks/permission.test.ts` → `tests/coding-agent/hooks/builtin/permission.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: `HookRegistry<CodingHookContext>` and `CodingAgentInteractions`.
- Produces: `createDefaultCodingHookRegistry(context): CodingHookRegistry`, plus the internal `registerPermissionHook(registry): void`.

- [ ] **Step 1: Move the Hook tests and make them require the new API**

Create `tests/coding-agent/hooks/builtin/`, move both test files, update their relative imports to `src/coding-agent/hooks/builtin/`, and replace every `createCodingHookRegistry` reference with `createDefaultCodingHookRegistry`. Update `tests/coding-agent/factory.test.ts` descriptions if they name the old factory. Add the new factory to the public import smoke test and remove the old name.

- [ ] **Step 2: Verify the new Hook API is red**

Run:

```powershell
npm run typecheck
```

Expected: FAIL because `hooks/builtin/*` and `createDefaultCodingHookRegistry` do not exist yet.

- [ ] **Step 3: Move the built-in Hook implementation and rename the factory**

Create `src/coding-agent/hooks/builtin/`, move the two implementation files, then update imports for their extra directory depth. Rename the factory declaration and every source caller:

```ts
export function createDefaultCodingHookRegistry(
  context: CodingHookContext,
): CodingHookRegistry;
```

Keep `CodingHookContext` and `CodingHookRegistry` in `hooks/types.ts`. Make `hooks/index.ts` export the shared types, the renamed default factory, and `registerPermissionHook`. Update the package root and `coding-agent/factory.ts`; do not export the old name.

- [ ] **Step 4: Verify Hook tests and imports**

Run:

```powershell
npm run build
node --test "dist/tests/coding-agent/hooks/**/*.test.js" "dist/tests/coding-agent/factory.test.js" "dist/tests/import-smoke.test.js"
rg -n "createCodingHookRegistry|coding-agent/hooks/(factory|permission)" src tests --glob '!dist/**'
```

Expected: tests PASS and `rg` returns no matches.

- [ ] **Step 5: Commit the Hook structure**

```powershell
git add src/coding-agent/hooks src/coding-agent/factory.ts src/coding-agent/index.ts tests/coding-agent/hooks tests/coding-agent/factory.test.ts tests/import-smoke.test.ts
git commit -m "refactor: separate built-in coding hooks"
```

### Task 2: Move concrete Tools under `tools/builtin`

**Files:**
- Move: `src/coding-agent/tools/factory.ts` → `src/coding-agent/tools/builtin/factory.ts`
- Move: `src/coding-agent/tools/bash.ts` → `src/coding-agent/tools/builtin/bash/definition.ts`
- Move: `src/coding-agent/tools/bash-ops.ts` → `src/coding-agent/tools/builtin/bash/operations.ts`
- Move: `src/coding-agent/tools/bash-policy.ts` → `src/coding-agent/tools/builtin/bash/policy.ts`
- Move: `src/coding-agent/tools/files.ts` → `src/coding-agent/tools/builtin/files.ts`
- Move: `src/coding-agent/tools/glob.ts` → `src/coding-agent/tools/builtin/glob.ts`
- Move: `src/coding-agent/tools/todo-write.ts` → `src/coding-agent/tools/builtin/todo/definition.ts`
- Move: `src/coding-agent/tools/todo-state.ts` → `src/coding-agent/tools/builtin/todo/projection.ts`
- Modify: `src/coding-agent/tools/index.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/hooks/builtin/permission.ts`
- Modify: `src/coding-agent/index.ts`
- Move: `tests/coding-agent/tools/bash.test.ts` → `tests/coding-agent/tools/builtin/bash/definition.test.ts`
- Move: `tests/coding-agent/tools/files.test.ts` → `tests/coding-agent/tools/builtin/files.test.ts`
- Move: `tests/coding-agent/tools/factory.test.ts` → `tests/coding-agent/tools/builtin/factory.test.ts`
- Move: `tests/coding-agent/tools/todo-write.test.ts` → `tests/coding-agent/tools/builtin/todo/definition.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/harness/session.test.ts`

**Interfaces:**
- Consumes: root-level `CodingToolDefinition`, `CodingToolContext`, and `toAgentTool()`.
- Produces: the same built-in creation functions, Bash policy, `TodoItem`, `TodoDetails`, `formatTodoContent()`, and `findLatestTodoDetails()` from new internal locations and the stable package/tool barrel exports.

- [ ] **Step 1: Move Tool tests to mirror the target structure**

Create the target test directories, move the four built-in test files, and update imports to the target `tools/builtin/` paths. Change `tests/harness/session.test.ts` to import `findLatestTodoDetails` from `tools/builtin/todo/projection.js`. Keep wrapper tests at `tests/coding-agent/tools/wrapper.test.ts` because wrapper is shared infrastructure.

- [ ] **Step 2: Verify the target Tool paths are red**

Run:

```powershell
npm run typecheck
```

Expected: FAIL because the new built-in Tool paths do not exist.

- [ ] **Step 3: Move concrete Tool files and repair local imports**

Create `tools/builtin/bash/` and `tools/builtin/todo/`, then perform the listed moves. Update imports using the new depth:

- Built-in definitions import `CodingToolDefinition` from `../../definition.js` or `../../../definition.js`.
- Bash `definition.ts` imports `operations.ts` and `policy.ts` locally.
- Permission Hook imports Bash policy from `../../tools/builtin/bash/policy.js` relative to its own final location.
- Todo definition imports domain helpers from `./projection.js`.
- `tools/builtin/factory.ts` imports every built-in definition and returns the same six tools in the same order.

Keep `definition.ts`, `wrapper.ts`, and `index.ts` at the `tools/` root.

- [ ] **Step 4: Restore barrel and package exports**

Update `tools/index.ts`, `coding-agent/index.ts`, and `coding-agent/factory.ts` so callers still receive:

```ts
createDefaultToolDefinitions
toAgentTool
CodingToolContext
CodingToolDefinition
TodoItem
TodoDetails
```

The root package does not need to export each built-in creation function, matching current behavior. The feature barrel `tools/index.ts` may continue exposing them for internal/tool-focused use.

- [ ] **Step 5: Verify Tool behavior and absence of old paths**

Run:

```powershell
npm run build
node --test "dist/tests/coding-agent/tools/**/*.test.js" "dist/tests/coding-agent/factory.test.js" "dist/tests/harness/session.test.js"
rg -n "tools/(bash|bash-ops|bash-policy|files|glob|todo-write|todo-state|factory)" src tests --glob '!dist/**'
```

Expected: tests PASS and `rg` returns no old source-path imports.

- [ ] **Step 6: Commit the Tool structure**

```powershell
git add src/coding-agent/tools src/coding-agent/hooks/builtin/permission.ts src/coding-agent/factory.ts src/coding-agent/index.ts tests/coding-agent/tools tests/coding-agent/factory.test.ts tests/harness/session.test.ts
git commit -m "refactor: group built-in coding tools"
```

### Task 3: Split the two Coding Agent UI seams

**Files:**
- Replace: `src/coding-agent/ui/interactions.ts`
- Create: `src/coding-agent/ui/interactions/types.ts`
- Create: `src/coding-agent/ui/interactions/unavailable.ts`
- Move: `src/coding-agent/ui/tool-presentation.ts` → `src/coding-agent/ui/presentation/types.ts`
- Move: `src/coding-agent/ui/presentation-registry.ts` → `src/coding-agent/ui/presentation/registry.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/runtime.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/hooks/types.ts`
- Modify: `src/coding-agent/hooks/builtin/permission.ts`
- Modify: `src/coding-agent/tools/definition.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `src/ui/cli-harness-renderer.ts`
- Modify: tests importing Coding Agent UI deep paths
- Move: `tests/coding-agent/ui/presentation-registry.test.ts` → `tests/coding-agent/ui/presentation/registry.test.ts`

**Interfaces:**
- Consumes: `HarnessToolEvent`, `AgentToolCall`, and `AgentToolResult`.
- Produces: unchanged `CodingAgentInteractions`, `NO_INTERACTIONS`, `CodingToolPresentation`, and `CodingToolPresentationRegistry` behavior from responsibility-specific directories.

- [ ] **Step 1: Move the presentation test and require the new paths**

Move the Registry test to `tests/coding-agent/ui/presentation/registry.test.ts`. Update all test and `src/ui/` deep imports from `coding-agent/ui/presentation-registry.js` to `coding-agent/ui/presentation/registry.js`. Update type imports to `ui/presentation/types.js` and interaction imports to `ui/interactions/types.js` or `ui/interactions/unavailable.js` as appropriate.

- [ ] **Step 2: Verify the new UI paths are red**

Run:

```powershell
npm run typecheck
```

Expected: FAIL because the new UI seam paths do not exist.

- [ ] **Step 3: Move presentation modules and split interactions**

Create both UI subdirectories. Move the presentation modules and update their relative Agent/Harness imports for the extra directory depth. Split `interactions.ts` exactly by responsibility:

```ts
// interactions/types.ts
export interface ConfirmationRequest { /* existing fields */ }
export interface Notification { /* existing fields */ }
export interface CodingAgentInteractions { /* existing methods */ }

// interactions/unavailable.ts
export const NO_INTERACTIONS: CodingAgentInteractions = Object.freeze({
  available: false,
  async confirm() { return false; },
  notify() { return undefined; },
});
```

Delete the old flat files rather than retaining re-export shims.

- [ ] **Step 4: Update all source imports and root exports**

Update Coding Agent factory/runtime/types, Hook types/permission, Tool definition, package index, and CLI renderer/frontend. Preserve the root `src/coding-agent/index.ts` API so ordinary callers need no deep path changes.

- [ ] **Step 5: Verify both UI seams**

Run:

```powershell
npm run build
node --test "dist/tests/coding-agent/ui/**/*.test.js" "dist/tests/ui/**/*.test.js" "dist/tests/coding-agent/factory.test.js" "dist/tests/import-smoke.test.js"
rg -n "ui/(interactions|tool-presentation|presentation-registry)\.js" src tests --glob '!dist/**'
```

Expected: tests PASS. Matches are allowed only for the new `ui/interactions/...` directory, not the deleted flat modules.

- [ ] **Step 6: Commit the UI structure**

```powershell
git add src/coding-agent/ui src/coding-agent src/ui tests/coding-agent/ui tests/ui tests/main.test.ts tests/import-smoke.test.ts
git commit -m "refactor: separate coding ui seams"
```

### Task 4: Rewrite the Coding Agent README progressively

**Files:**
- Modify: `src/coding-agent/README.md`
- Modify: `docs/architecture.md` only if it contains now-invalid names or paths

**Interfaces:**
- Consumes: final package structure and public exports from Tasks 1–3.
- Produces: a beginner-readable package guide and complete API inventory.

- [ ] **Step 1: Rewrite the README in the approved order**

Use this exact progression:

```text
Coding Agent adds what to Harness
→ minimal createCodingAgent usage
→ CodingAgentRuntime
→ one complete factory assembly trace
→ Tool Definition and Tool data lifetimes
→ Todo projection from Session
→ Hook, Interactions, Event, Presentation
→ folder structure and dependencies
→ complete public API
```

Explain that a Tool has no single state scope. Explicitly distinguish one Tool Call, one Runtime, one Session, and the project environment. State that `todo_write` is stateless and that `projection.ts` reconstructs domain state from Session messages.

- [ ] **Step 2: Explain the two UI seams without inventing future modules**

Document:

- `interactions`: Hook asks the frontend to confirm or notify;
- `presentation`: Coding Tool events become display text;
- Harness Event: passive fact stream;
- Agent Hook: control channel.

State that a future CLI/TUI/Web Adapter can implement these seams, but do not claim such frontends or a renderer tree already exist.

- [ ] **Step 3: Audit names, directories, and exports**

Run:

```powershell
rg -n "createCodingHookRegistry|todo-state|tools/(bash|files|glob|todo-write)|ui/(interactions|tool-presentation|presentation-registry)\.ts" src/coding-agent/README.md docs/architecture.md
rg -n "createDefaultCodingHookRegistry|Tool Call|Runtime|Session|project environment|interactions|presentation|Harness Event|Agent Hook" src/coding-agent/README.md
```

Expected: no stale names or paths; every required concept appears.

- [ ] **Step 4: Commit the README**

```powershell
git add src/coding-agent/README.md docs/architecture.md
git commit -m "docs: rewrite coding agent readme progressively"
```

### Task 5: Final package verification

**Files:**
- Verify: all changed source, tests, and documentation

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: evidence that the moved package retains behavior and exposes only the approved names.

- [ ] **Step 1: Check the final directory shape and stale paths**

Run:

```powershell
Get-ChildItem src/coding-agent -Recurse -File | ForEach-Object { $_.FullName.Replace((Resolve-Path .).Path + '\\', '') }
rg -n "createCodingHookRegistry|AfterToolCallPatch|todo-state|coding-agent/ui/(interactions|tool-presentation|presentation-registry)\.js" src tests README.md docs/architecture.md --glob '!dist/**'
```

Expected: directory matches the spec and no stale current API terms remain.

- [ ] **Step 2: Run complete verification**

Run:

```powershell
npm test
npm run typecheck
git diff --check
```

Expected: all tests PASS; typecheck and diff check exit 0.

- [ ] **Step 3: Inspect repository status**

Run:

```powershell
git status --short
git log -5 --oneline
```

Expected: no uncommitted changes and four focused implementation commits after this plan.
