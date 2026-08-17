# Coding Agent Cleanup Design

## Goal

Clean up `src/coding-agent` around the architecture that is already taking shape. Keep one composition root, keep the public API small, and move the dynamic system prompt into a clearly named module without introducing configuration abstractions that are not needed yet.

## Scope

This change only covers `src/coding-agent`.

It does not adapt `src/ui`, `src/main.ts`, other outer entry points, or existing tests. Those layers may remain temporarily incompatible while the coding-agent refactor is in progress.

## Resulting structure

```text
src/coding-agent/
├── factory.ts
├── system-prompt.ts
├── index.ts
├── events/
├── interaction/
├── project/
│   ├── project.ts
│   └── storage.ts
└── tools/
```

`factory.ts` is the sole composition root. `project/project.ts` contains Project behavior, while `project/storage.ts` contains persistence concerns.

## Object lifetimes and ownership

- `Events` has Project lifetime. `openOrCreateProject()` creates one Events instance for the Project, and every harness created by that Project uses it.
- `ToolRegistry` has agent-harness lifetime. The Project creates a fresh default registry for each harness rather than retaining one Project-wide registry.
- Permission approval state remains outside the Project's public model. The composition root creates the state required by the builtin permission flow and closes over it when constructing Project dependencies.

These lifetimes preserve the current separation: Project consumes Events, while each agent harness owns its tool registry.

## Composition root

Move the current implementation of `src/coding-agent/project/factory.ts` to `src/coding-agent/factory.ts`, replacing the stale factory implementation already at that location.

`openOrCreateProject()` continues to:

1. Resolve or create Project storage.
2. Create the Project-scoped approval state, Events, and Sessions dependencies.
3. Construct and return the Project.

Its existing explanatory comment should remain with the moved implementation. Imports must be updated for the new location, but factory behavior must not otherwise change.

## Dynamic system prompt

Rename the prompt module to `system-prompt.ts`. Keep the prompt body in a
module-level `SYSTEM_PROMPT_TEMPLATE` constant with placeholders for the two
dynamic values, then expose one simple function:

```ts
export function createSystemPrompt(
  projectDirectory: string,
  cwd: string,
): string
```

Do not introduce `SystemPromptOptions`, skill hooks, or other extension points yet. If skill configuration later changes the prompt, the interface can be revised when that requirement is concrete.

`createSystemPrompt()` starts with the template, replaces the
`{{projectDirectory}}` and `{{cwd}}` placeholders, and returns the populated
prompt. This keeps the long prompt content separate from parameter
substitution.

The generated prompt is:

```text
You are Kea, a coding agent working on a software project. Use the available tools to inspect the codebase, modify files, and run commands needed to complete the user's request.

## Workspace

- Project directory: <projectDirectory>
- Session working directory: <cwd>
- Relative tool paths resolve from the Session working directory.
- The Project directory is trusted. Access outside it may require user approval.

## Working principles

- Follow the user's instructions and preserve unrelated work.
- Read relevant code before changing it; match existing conventions and keep changes focused.
- Check exact targets before destructive or irreversible actions.
- Verify results in proportion to risk, and accurately report failures or skipped verification.
```

`Project` calls `createSystemPrompt(projectDirectory, cwd)` when creating a harness. Its private prompt-formatting method is removed.

## Public API

Rewrite `src/coding-agent/index.ts` as a minimal API surface:

```ts
export { openOrCreateProject } from "./factory.js";
export { ProjectError } from "./project/project.js";
export type { Project, ProjectInfo } from "./project/project.js";
export type {
  Interactions,
  PermissionRequest,
  PermissionReply,
} from "./interaction/interactions.js";
```

The system-prompt builder, builtin factories, storage implementation, rule types, and todo types remain internal until an external caller actually needs them.

## Deletions

Remove the following stale or superseded code:

- `src/coding-agent/ui/`
- `src/coding-agent/types.ts`
- `src/coding-agent/coding-system-prompt.ts`
- `src/coding-agent/project/factory.ts` after moving its implementation
- the existing stale implementation of `src/coding-agent/factory.ts`

No compatibility aliases are added.

## Behavior and error handling

This cleanup must preserve the current Project, Events, permission, and tools behavior. It changes module placement, prompt construction, and exports only. Existing errors continue to propagate through the same paths; this change adds no new error categories or fallback behavior.

## Verification

Verification is intentionally limited to the refactor boundary:

- Inspect references within `src/coding-agent` for obsolete module paths and deleted symbols.
- Confirm every intended deletion target is gone.
- Review the diff for accidental changes to Project, Events, permission, or tools behavior.
- Do not run the existing tests or require the outer application to compile, because those layers are outside this cleanup and are expected to remain temporarily stale.
