# Coding Agent Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove shallow Coding Agent definitions and rewrite its README around the small project-level model built on Harness.

**Architecture:** Keep `createCodingAgent()` as the composition root. A `CodingToolDefinition` remains the single necessary seam between Agent execution and Coding Agent presentation, while permissions use the generic Agent `HookRegistry` and UI receives only `confirm`, `notify`, Harness events, and a tool-event rendering function.

**Tech Stack:** TypeScript 7, Node.js 24, TypeBox, `node:test`.

## Global Constraints

- Do not change Agent Loop, Harness, Session, built-in tool behavior, or Bash permission rules.
- Do not add compatibility aliases for removed internal exports or deep paths.
- Do not add a general Tool state container, Extension host, frontend hierarchy, or speculative execution backend.
- A no-UI runtime must deny commands that require confirmation.
- Tool presentation must stay outside Agent and Harness.
- Use `apply_patch` for file edits and commit each independently reviewable task on `master`.

---

## Final File Structure

```text
src/coding-agent/
  coding-system-prompt.ts
  factory.ts
  index.ts
  README.md
  types.ts
  hooks/
    permission.ts
  tools/
    definition.ts
    builtin/
      bash.ts
      bash-policy.ts
      files.ts
      todo.ts
  ui/
    interactions.ts
    presentation.ts
```

`files.ts` owns read, write, edit, and glob because all four operate on the Project filesystem.
`presentation.ts` contains the presentation contract and its internal registry because they always change
together and the registry is no longer public.

### Task 1: Simplify Interactions and Permission Hook

**Files:**
- Create: `src/coding-agent/ui/interactions.ts`
- Create: `src/coding-agent/hooks/permission.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/ui/cli-interactions.ts`
- Modify: `tests/coding-agent/hooks/builtin/permission.test.ts`
- Modify: `tests/coding-agent/hooks/builtin/factory.test.ts`
- Delete: `src/coding-agent/ui/interactions/types.ts`
- Delete: `src/coding-agent/ui/interactions/unavailable.ts`
- Delete: `src/coding-agent/hooks/types.ts`
- Delete: `src/coding-agent/hooks/index.ts`
- Delete: `src/coding-agent/hooks/builtin/factory.ts`
- Delete: `src/coding-agent/hooks/builtin/permission.ts`

**Interfaces:**
- Consumes: `HookRegistry<TContext>.register("tool_call", handler)` and Bash `classifyBashCommand(command)`.
- Produces: `CodingAgentInteractions`, `ConfirmationRequest`, `Notification`, `NO_INTERACTIONS`, and internal `createPermissionHooks(context)`.

- [ ] **Step 1: Change permission tests to the smaller contract**

Replace `RecordingUI.available` and the `CodingHookContext` root import. Import the internal factory from
`src/coding-agent/hooks/permission.ts` and assert that `confirm() => false` represents unavailable UI:

```ts
class RecordingInteractions implements CodingAgentInteractions {
  readonly confirmations: ConfirmationRequest[] = [];
  constructor(private readonly answer: boolean | Error) {}
  async confirm(request: ConfirmationRequest): Promise<boolean> {
    this.confirmations.push(request);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
  notify(): void {}
}

const hooks = createPermissionHooks({
  cwd: process.cwd(),
  interactions: new RecordingInteractions(false),
});
```

Keep allow, deny, approval, decline, error, non-Bash, and signal-forwarding assertions. Change the old
“without UI” factory test to construct the factory without `interactions` and continue asserting that an
ask-class Bash call is blocked.

- [ ] **Step 2: Run the focused tests and verify compilation fails**

Run: `npm run build`

Expected: FAIL because `createPermissionHooks` and the consolidated interactions module do not exist and
the old interface still requires `available`.

- [ ] **Step 3: Add the consolidated interactions module**

Create `ui/interactions.ts` with the three request/port interfaces and the fail-closed constant:

```ts
export interface CodingAgentInteractions {
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}

export const NO_INTERACTIONS: CodingAgentInteractions = Object.freeze({
  async confirm() { return false; },
  notify() {},
});
```

Move the existing `ConfirmationRequest` and `Notification` fields unchanged. Remove `available` from
`CliInteractions`.

- [ ] **Step 4: Add one permission composition module**

Create `hooks/permission.ts`. Keep its context local, create `HookRegistry<PermissionContext>`, and register
the existing `tool_call` handler inside `createPermissionHooks()`:

```ts
interface PermissionContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}

export function createPermissionHooks(
  context: PermissionContext,
): HookRegistry<PermissionContext> {
  const hooks = new HookRegistry(context);
  hooks.register("tool_call", async (call, current, signal) => {
    // preserve existing non-Bash, allow, deny, confirm, and error behavior
  });
  return hooks;
}
```

Do not check an `available` flag. Every ask decision calls `confirm()`; false blocks with
`permission denied by user`, and thrown errors block with `permission confirmation failed: ...`.

- [ ] **Step 5: Rewire the factory and delete the shallow Hook modules**

Import `createPermissionHooks` and `NO_INTERACTIONS` from the new files. Delete both barrel files, the
Hook type alias, and the two `builtin` Hook files. Update test imports to the new internal path.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- --test-name-pattern="permission|fail-closed"`

Expected: PASS for permission and factory fail-closed tests.

- [ ] **Step 7: Commit**

```powershell
git add src/coding-agent/hooks src/coding-agent/ui src/coding-agent/factory.ts src/ui/cli-interactions.ts tests/coding-agent/hooks tests/coding-agent/factory.test.ts
git commit -m "refactor: simplify coding permission interactions"
```

### Task 2: Deepen the Coding Tool Definition Module

**Files:**
- Modify: `src/coding-agent/tools/definition.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `tests/coding-agent/tools/wrapper.test.ts`
- Delete: `src/coding-agent/tools/wrapper.ts`
- Delete: `src/coding-agent/tools/index.ts`
- Delete: `src/coding-agent/tools/builtin/factory.ts`
- Delete: `tests/coding-agent/tools/builtin/factory.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `AgentToolResult`, and `CodingToolPresentation`.
- Produces: public `CodingToolDefinition`, `CodingToolContext`; internal `toAgentTool(definition, context)`.

- [ ] **Step 1: Point the adapter test at the definition module**

Change `tests/coding-agent/tools/wrapper.test.ts` to import both `CodingToolDefinition` and `toAgentTool`
from `tools/definition.ts`. Rename the test file to `tests/coding-agent/tools/definition.test.ts`.

- [ ] **Step 2: Run the renamed test and verify it fails**

Run: `npm run build`

Expected: FAIL because `definition.ts` does not export `toAgentTool`.

- [ ] **Step 3: Move the adapter implementation beside the definition**

Move `CodingAgentToolAdapter` and `toAgentTool()` unchanged from `wrapper.ts` into `definition.ts` beneath
the interface. Keep `toAgentTool` exported from this internal module so it can be tested, but remove it
from `coding-agent/index.ts` in Task 5.

- [ ] **Step 4: Put the default tool list in the composition root**

In `factory.ts`, replace `createDefaultToolDefinitions()` with an explicit array:

```ts
const definitions: readonly CodingToolDefinition[] = [
  createBashToolDefinition(),
  createReadFileToolDefinition(),
  createWriteFileToolDefinition(),
  createEditFileToolDefinition(),
  createGlobToolDefinition(),
  createTodoWriteToolDefinition(),
];
```

Import each internal factory directly. Delete `tools/builtin/factory.ts`, its test, `wrapper.ts`, and the
unused Tool barrel.

- [ ] **Step 5: Run definition and factory tests**

Run: `npm test -- --test-name-pattern="toAgentTool|factory composes"`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/coding-agent/tools src/coding-agent/factory.ts tests/coding-agent/tools tests/coding-agent/factory.test.ts
git commit -m "refactor: deepen coding tool definition"
```

### Task 3: Simplify Bash and Project File Tools

**Files:**
- Create: `src/coding-agent/tools/builtin/bash.ts`
- Create: `src/coding-agent/tools/builtin/bash-policy.ts`
- Modify: `src/coding-agent/tools/builtin/files.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/hooks/permission.ts`
- Rename: `tests/coding-agent/tools/builtin/bash/definition.test.ts` to `tests/coding-agent/tools/builtin/bash.test.ts`
- Modify: `tests/coding-agent/tools/builtin/files.test.ts`
- Delete: `src/coding-agent/tools/builtin/bash/definition.ts`
- Delete: `src/coding-agent/tools/builtin/bash/operations.ts`
- Delete: `src/coding-agent/tools/builtin/bash/policy.ts`
- Delete: `src/coding-agent/tools/builtin/glob.ts`

**Interfaces:**
- Produces: internal `createBashToolDefinition()`, `classifyBashCommand()`, `hardDeniedBashReason()`, and four Project file definition factories.

- [ ] **Step 1: Update tests to the final module paths**

Move the Bash test and import from `builtin/bash.ts`. Replace `RecordingBashOperations` with an injected
function:

```ts
const calls: string[] = [];
const definition = createBashToolDefinition(async (command) => {
  calls.push(command);
  return "executed";
});
```

Add a file-tools assertion that `createGlobToolDefinition` is exported from `builtin/files.ts` and returns
workspace-relative matches with `/` separators.

- [ ] **Step 2: Run the focused build and verify it fails**

Run: `npm run build`

Expected: FAIL because the final Bash paths and the `files.ts` glob factory do not exist.

- [ ] **Step 3: Replace the Bash backend interface with one function**

Create `bash.ts` containing schema, shell selection, child-process execution, and definition. Use a private
function type rather than an exported interface/class:

```ts
type ExecuteBash = (
  command: string,
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

export function createBashToolDefinition(
  executeBash: ExecuteBash = executeLocalBash,
): CodingToolDefinition<typeof parameters> {
  return {
    name: "bash",
    description: "Run a shell command.",
    parameters,
    async execute({ command }, signal, context) {
      const reason = hardDeniedBashReason(command);
      if (reason !== undefined) {
        return {
          content: `Error: Permission denied: ${reason}`,
          isError: true,
        };
      }
      try {
        return {
          content: await executeBash(command, resolve(context.cwd), signal),
          isError: false,
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}
```

Keep UTF-8 output, Windows Git Bash fallback, abort propagation, non-zero exit errors, and the hard-deny
backstop unchanged.

- [ ] **Step 4: Move the shared policy without changing rules**

Move `HARD_DENY_RULES`, `ASK_RULES`, `hardDeniedBashReason`, and `classifyBashCommand` into
`bash-policy.ts`. Update the Permission Hook and Bash definition imports.

- [ ] **Step 5: Move glob into the Project file module**

Append the current glob schema and `createGlobToolDefinition()` to `files.ts`; retain `safePath()` checks
and normalized `/` output. Delete `glob.ts` and the old Bash directory.

- [ ] **Step 6: Run Bash and file tests**

Run: `npm test -- --test-name-pattern="bash|file|glob"`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/coding-agent/tools/builtin src/coding-agent/hooks/permission.ts src/coding-agent/factory.ts tests/coding-agent/tools/builtin
git commit -m "refactor: simplify built-in project tools"
```

### Task 4: Consolidate Stateless Todo

**Files:**
- Create: `src/coding-agent/tools/builtin/todo.ts`
- Modify: `src/coding-agent/factory.ts`
- Rename: `tests/coding-agent/tools/builtin/todo/definition.test.ts` to `tests/coding-agent/tools/builtin/todo.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/harness/session.test.ts`
- Delete: `src/coding-agent/tools/builtin/todo/definition.ts`
- Delete: `src/coding-agent/tools/builtin/todo/projection.ts`

**Interfaces:**
- Produces: public `TodoItem`, `TodoDetails`; internal `createTodoWriteToolDefinition()`.

- [ ] **Step 1: Update Todo tests to one module and remove unused projection tests**

Move the definition test and import from `builtin/todo.ts`. Keep assertions that every call receives the
whole list and returns the same list in model-visible `content` and `details.todos`.

Delete the two `findLatestTodoDetails` tests and their import from `tests/harness/session.test.ts` because
there is no production consumer. Keep the factory Session restoration test proving Todo content survives
Session restore and model switch.

- [ ] **Step 2: Run the build and verify it fails**

Run: `npm run build`

Expected: FAIL because `builtin/todo.ts` does not exist.

- [ ] **Step 3: Put the complete Todo domain in one file**

Move `TodoItem`, `TodoDetails`, schema, formatting, details validation, definition, and Todo presentation
into `todo.ts`. Keep `formatTodoContent()` and `isTodoDetails()` private. Do not add a Tool instance field,
state container, or Session dependency.

- [ ] **Step 4: Rewire imports and delete the Todo directory**

Update `factory.ts`, factory tests, and root type exports to `builtin/todo.ts`. Delete both old files and
their now-empty directory.

- [ ] **Step 5: Run Todo, Session, and factory tests**

Run: `npm test -- --test-name-pattern="todo|Session|model switch"`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/coding-agent/tools/builtin src/coding-agent/factory.ts src/coding-agent/index.ts tests/coding-agent tests/harness/session.test.ts
git commit -m "refactor: consolidate stateless todo tool"
```

### Task 5: Expose a Read-Only Tool Presentation Function

**Files:**
- Create: `src/coding-agent/ui/presentation.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/ui/cli-frontend.ts`
- Modify: `src/ui/cli-harness-renderer.ts`
- Modify: `tests/coding-agent/ui/presentation/registry.test.ts`
- Modify: `tests/ui/cli-harness-renderer.test.ts`
- Modify: `tests/ui/cli-frontend.test.ts`
- Modify: `tests/main.test.ts`
- Delete: `src/coding-agent/ui/presentation/types.ts`
- Delete: `src/coding-agent/ui/presentation/registry.ts`

**Interfaces:**
- Produces: public `CodingToolPresentation`, `ToolPresentationCall`, `ToolPresentationRejected`; internal `CodingToolPresentationRegistry`; runtime `renderToolEvent(event): string`.

- [ ] **Step 1: Change runtime consumer tests to the read-only function**

Replace fake runtime `presentations` fields with:

```ts
renderToolEvent(event) {
  return `[tool] ${event.call.name}`;
}
```

Update `CliHarnessRenderer` construction tests to pass a `(event) => string` function. Keep the registry's
own focused tests on the internal module.

- [ ] **Step 2: Run the build and verify it fails**

Run: `npm run build`

Expected: FAIL because `CodingAgentRuntime` still requires `presentations` and the renderer constructor
still expects the registry.

- [ ] **Step 3: Consolidate presentation types and registry**

Move the existing public presentation types and internal registry into `ui/presentation.ts`. Delete
`ToolPresentationOutput` and use `string | undefined` directly in all three renderer signatures. Preserve
duplicate protection, unknown-tool fallbacks, error isolation, and non-JSON-safe argument handling.

- [ ] **Step 4: Narrow the runtime**

Change `CodingAgentRuntime` to:

```ts
export interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly renderToolEvent: (event: HarnessToolEvent) => string;
}
```

In `createCodingAgent()`, retain the registry in a closure and return:

```ts
return {
  harness,
  renderToolEvent: (event) => presentations.render(event),
};
```

- [ ] **Step 5: Rewire CLI consumers**

Make `CliHarnessRenderer` accept `renderToolEvent: (event: HarnessToolEvent) => string`. In
`CliFrontend.run()`, pass `runtime.renderToolEvent`. No UI module may import the registry class.

- [ ] **Step 6: Run presentation and UI tests**

Run: `npm test -- --test-name-pattern="presentation|renderer|frontend"`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/coding-agent/ui src/coding-agent/types.ts src/coding-agent/factory.ts src/ui tests/coding-agent/ui tests/ui tests/main.test.ts
git commit -m "refactor: expose read-only tool presentation"
```

### Task 6: Narrow the Public API and Rewrite Documentation

**Files:**
- Modify: `src/coding-agent/index.ts`
- Modify: `tests/import-smoke.test.ts`
- Modify: `src/coding-agent/README.md`
- Modify: `docs/architecture.md`
- Modify: `src/agent/README.md`
- Modify: `docs/superpowers/specs/2026-08-13-coding-agent-structure-readme-design.md`

**Interfaces:**
- Produces: the final public API listed in the approved simplification spec.

- [ ] **Step 1: Make the import smoke test describe the intended public surface**

Remove value imports for `createDefaultCodingHookRegistry`, `createDefaultToolDefinitions`, `toAgentTool`,
and `CodingToolPresentationRegistry`. Remove the `CodingHookContext` type import. Keep:

```ts
import { createCodingAgent, CODING_SYSTEM_PROMPT, NO_INTERACTIONS } from "../src/coding-agent/index.js";
import type {
  CodingAgentRuntime,
  CreateCodingAgentConfig,
  CodingAgentInteractions,
  CodingToolContext,
  CodingToolDefinition,
  CodingToolPresentation,
  ConfirmationRequest,
  Notification,
  TodoDetails,
  TodoItem,
  ToolPresentationCall,
  ToolPresentationRejected,
} from "../src/coding-agent/index.js";
```

- [ ] **Step 2: Run the smoke test before changing exports**

Run: `npm test -- --test-name-pattern="public core imports"`

Expected: PASS; this establishes that the smaller consumer surface is sufficient before exports are
removed.

- [ ] **Step 3: Remove internal exports from the root**

Make `coding-agent/index.ts` export only the values and types in Step 1. Update paths to the consolidated
interactions, presentation, definition, and Todo modules. Do not add compatibility aliases.

- [ ] **Step 4: Rewrite README progressively from Harness upward**

Write the README in this exact conceptual order:

1. Coding Agent is a Project-specific assembly on top of Harness.
2. `HarnessProject` means a working directory plus Session storage directory.
3. Minimal `createCodingAgent()` use and the two runtime capabilities.
4. One complete trace: prompt → permission Hook → Agent Tool → Session/Event → UI rendering.
5. Why `CodingToolDefinition` contains execution plus optional presentation while Agent receives only execution.
6. Bash trace: policy allow/ask/deny → optional `confirm()` → local child process → result.
7. Todo trace: full-list input → content/details output → Harness persists result in Session; no Tool state.
8. UI separation: interactions are requests; Harness Events are facts; `renderToolEvent` converts only tool facts.
9. Final source layout, dependency prose, and exhaustive public API.

Define each new term at first use. Do not include an architecture diagram, registry walkthrough, historical
design alternatives, or implementation-only exports.

- [ ] **Step 5: Repair documentation references**

Replace old paths and public symbols in `docs/architecture.md` and `src/agent/README.md`. In the older
structure design spec, add a short superseded note pointing to the new simplification spec; do not rewrite
historical implementation plans as current documentation.

- [ ] **Step 6: Scan for stale names and paths**

Run:

```powershell
rg -n "createDefaultCodingHookRegistry|createDefaultToolDefinitions|CodingHookContext|CodingHookRegistry|CodingToolPresentationRegistry|\.presentations|findLatestTodoDetails|BashOperations|LocalBashOperations|tools/builtin/(bash/|todo/)|tools/(wrapper|index)|hooks/(builtin|types|index)" src tests docs/architecture.md
```

Expected: no current source, test, README, or architecture references. Historical plan/spec references may
remain only inside explicitly superseded documents.

- [ ] **Step 7: Run complete verification**

Run:

```powershell
npm test
npm run typecheck
git diff --check
git status --short
```

Expected: all tests pass, typecheck exits 0, diff check emits nothing, and status contains only the intended
Task 6 files.

- [ ] **Step 8: Commit**

```powershell
git add src/coding-agent/index.ts src/coding-agent/README.md src/agent/README.md tests/import-smoke.test.ts docs/architecture.md docs/superpowers/specs/2026-08-13-coding-agent-structure-readme-design.md
git commit -m "docs: explain the coding agent progressively"
```

### Task 7: Final Structure and Quality Audit

**Files:**
- Inspect: `src/coding-agent/**`
- Inspect: `tests/coding-agent/**`
- Modify only files required by audit findings.

**Interfaces:**
- Verifies every public and internal interface introduced by Tasks 1–6.

- [ ] **Step 1: Verify the final file inventory**

Run: `rg --files src/coding-agent tests/coding-agent | Sort-Object`

Expected: source matches the Final File Structure; tests mirror real concepts without empty `builtin/factory`,
`wrapper`, or nested Bash/Todo directories.

- [ ] **Step 2: Apply the deletion test**

For every remaining Coding Agent interface, class, type alias, and factory, verify one of the approved
retention reasons applies. In particular, ensure there is no public wrapper around `HookRegistry`, no
single-implementation Bash backend, no string-only alias, and no second runtime state owner.

- [ ] **Step 3: Run fresh complete verification**

Run:

```powershell
npm test
npm run typecheck
git diff --check
git status --short
```

Expected: tests and typecheck pass; no whitespace errors; worktree is clean after prior commits or contains
only an audit correction.

- [ ] **Step 4: Commit an audit correction only if needed**

```powershell
git add <exact corrected files>
git commit -m "fix: complete coding agent simplification"
```

Skip this commit when no correction is necessary.
