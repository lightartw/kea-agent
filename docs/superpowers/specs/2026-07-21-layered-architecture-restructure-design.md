# Layered Architecture Restructure

**Date:** 2026-07-21

## Summary

Kea Agent has grown to ~15 source files in a flat `src/` directory. The code
already has implicit layers — LLM client → hooks → tools → agent loop → CLI —
but the directory structure doesn't reflect this. The CLI file mixes rendering,
I/O, and session control. The agent loop has no formal harness; persistence and
project management don't exist yet.

This change restructures the codebase into four explicit layers following Pi
agent's architecture, adds an AgentHarness for session persistence and project
management, and separates the generic agent kernel from coding-specific tools
and policies.

## Goals

- Reorganize `src/` into layered directories: `cli/` → `agent/` → `llm-client/`
  with `coding/` providing concrete tools on top.
- Introduce `agent/harness/` as the middle infrastructure layer: project model,
  session JSONL persistence, system prompt assembly — all tool-agnostic and
  UI-agnostic.
- Split `cli.ts` into pure render functions and a readline I/O class.
- Move PermissionHook from `hooks/builtin/` to `coding/` — it's a coding
  policy, not a generic hook.
- Move tool implementations (bash, files, glob) from `tools/builtin/` to
  `coding/tools/`. Move shared utility `workspace.ts` to `utils/`.
- Keep generic hook system and tool registry in `agent/`.
- Keep `llm-client/` structure unchanged.
- All existing tests continue to pass; import paths updated.
- No behavioral changes to the agent loop, permission pipeline, or tool execution.

## Non-goals

- Building a TUI framework or Component system.
- Compaction, tree navigation, prompt templates, or skills (future harness features).
- ExecutionEnv abstraction (direct node:fs/spawn for now).
- Changing package boundaries (no monorepo split).
- Adding new tools or modifying permission rules.
- Changing the LLM client interface or provider adapters.

## Target Directory Structure

```
src/
├── main.ts                         # Composition root (thin)
│
├── cli/                            # Layer 1: Presentation
│   ├── render.ts                   #   Pure ANSI rendering functions
│   └── frontend.ts                 #   CliFrontend (readline I/O + session loop)
│
├── llm-client/                     # Layer 2: AI abstraction (unchanged)
│   ├── index.ts
│   ├── types.ts                    #   Message, LLMResponse, LLMClient, LLMStreamEvent
│   ├── factory.ts                  #   createLLMClient()
│   ├── client.ts                   #   mergeOptions()
│   └── adapters/
│       ├── anthropic.ts
│       ├── openai.ts
│       └── gemini.ts
│
├── agent/                          # Layer 3: Agent kernel + Harness
│   ├── agent-loop.ts               #   runAgentTurn — pure async generator
│   ├── agent-session.ts            #   AgentSession — history + submit()
│   │
│   ├── harness/                    #   Harness — middle infrastructure
│   │   ├── agent-harness.ts        #     Wraps loop: project + sessions + hooks + prompt
│   │   ├── types.ts                #     Harness-level types and interfaces
│   │   ├── messages.ts             #     Custom message types + convertToLlm()
│   │   ├── system-prompt.ts        #     System prompt formatting
│   │   └── session/                #     Session persistence
│   │       ├── session.ts          #       Session class (tree-shaped history)
│   │       ├── jsonl-storage.ts    #       JSONL file read/write
│   │       └── session-repo.ts     #       Session file listing per project
│   │
│   ├── hooks/                      #   Generic hook system
│   │   ├── index.ts
│   │   ├── types.ts                #     HookEvent, PreToolUseEvent, Hook<T>, HookResult
│   │   ├── registry.ts             #     HookRegistry
│   │   └── factory.ts              #     createHookRegistry()
│   │
│   └── tools/                      #   Generic tool types + registry
│       ├── index.ts
│       ├── types.ts                #     Tool<T>, ToolCall, ToolResult, ToolSchema
│       └── registry.ts             #     ToolRegistry
│
├── coding/                         # Layer 4: Coding agent specifics
│   ├── permission.ts               #   PermissionHook (bash/files-aware policy)
│   └── tools/                      #   Built-in coding tools
│       ├── bash.ts
│       ├── files.ts
│       ├── glob.ts
│       └── factory.ts             #   createToolRegistry()
│
└── utils/
    ├── timeout.ts
    └── workspace.ts               #   safePath() — shared by coding tools
```

## Dependency Rules

```
cli/ ──→ agent/ ──→ llm-client/ ──→ utils/
            ↑
        coding/
```

- `cli/` may import from `agent/` and `coding/` (needs AgentEvent, PermissionRequest).
- `coding/` may import from `agent/` (tools register in generic registry, permission
  implements generic Hook).
- `agent/` may import from `llm-client/` and `utils/`.
- `llm-client/` may import from `utils/`.
- No circular dependencies. No layer skipping upward.

## Migration Map

| Current path | New path | Notes |
|---|---|---|
| `src/cli.ts` | `src/cli/render.ts` + `src/cli/frontend.ts` | Split render and I/O |
| `src/agent-turn.ts` | `src/agent/agent-loop.ts` | Pure loop, no behavior change |
| `src/agent-session.ts` | `src/agent/agent-session.ts` | No behavior change |
| `src/hooks/types.ts` | `src/agent/hooks/types.ts` | |
| `src/hooks/registry.ts` | `src/agent/hooks/registry.ts` | |
| `src/hooks/factory.ts` | `src/agent/hooks/factory.ts` | |
| `src/hooks/index.ts` | `src/agent/hooks/index.ts` | |
| `src/hooks/builtin/permission.ts` | `src/coding/permission.ts` | Coding policy, not generic hook |
| `src/tools/types.ts` | `src/agent/tools/types.ts` | Generic interface |
| `src/tools/registry.ts` | `src/agent/tools/registry.ts` | Generic registry |
| `src/tools/index.ts` | `src/agent/tools/index.ts` + `src/coding/tools/factory.ts` | Split generic from coding |
| `src/tools/builtin/bash.ts` | `src/coding/tools/bash.ts` | |
| `src/tools/builtin/files.ts` | `src/coding/tools/files.ts` | |
| `src/tools/builtin/glob.ts` | `src/coding/tools/glob.ts` | |
| `src/tools/builtin/workspace.ts` | `src/utils/workspace.ts` | Utility, not a tool |
| `src/tools/factory.ts` | `src/coding/tools/factory.ts` | |
| `src/llm-client/*` | `src/llm-client/*` | Unchanged |
| `src/main.ts` | `src/main.ts` | Rewrite as thin composition root |
| `src/index.ts` | `src/index.ts` | Update barrel exports |
| `src/utils/timeout.ts` | `src/utils/timeout.ts` | Unchanged |
| — | `src/agent/harness/agent-harness.ts` | New |
| — | `src/agent/harness/types.ts` | New |
| — | `src/agent/harness/messages.ts` | New |
| — | `src/agent/harness/system-prompt.ts` | New |
| — | `src/agent/harness/session/session.ts` | New |
| — | `src/agent/harness/session/jsonl-storage.ts` | New |
| — | `src/agent/harness/session/session-repo.ts` | New |

## Layer Designs

### Layer 1: `cli/` — Presentation

**`cli/render.ts`** — Pure functions, zero dependencies on agent concepts beyond
`AgentEvent` and `PermissionRequest` types:

```ts
// renderAgentEvent(event: AgentEvent, write, log): void
// Renders text_delta, tool_start, tool_end. No readline, no session loop.
```

**`cli/frontend.ts`** — `CliFrontend` class:

```ts
class CliFrontend {
  constructor()                                    // createInterface
  requestPermission(request: PermissionRequest): Promise<boolean>  // approval prompt
  run(session: AgentSession): Promise<void>        // session loop
  close(): void                                    // cleanup
}
```

The `requestPermission` method imports `PermissionRequest` from `coding/permission.ts`.
This is an intentional dependency: CLI is the presentation adapter for coding-agent
permission prompts. A future TUI would provide its own implementation.

### Layer 2: `llm-client/` — AI Abstraction

Unchanged. This layer is already clean and self-contained.

### Layer 3: `agent/` — Agent Kernel + Harness

#### `agent-loop.ts` — Pure Loop

```ts
// Unchanged from current agent-turn.ts, just relocated.
// Knows: messages, LLM client, tool registry, agent events.
// Does NOT know: sessions, projects, JSONL, system prompts, specific tools.

export async function* runAgentTurn(
  messages: Message[],
  client: LLMClient,
  registry: ToolRegistry,
): AsyncIterable<AgentEvent>;
```

#### `agent-session.ts` — Session State

```ts
// Holds message history and orchestrates one active submission.
// Does NOT know: JSONL files, project paths, system prompts.

export class AgentSession {
  constructor(client, registry, initialMessages?)
  get messages(): readonly Message[]
  submit(input: string): AsyncIterable<AgentEvent>
}
```

#### `harness/agent-harness.ts` — Assembly Core

The harness wraps AgentSession and adds infrastructure. It is tool-agnostic
and UI-agnostic.

```ts
export class AgentHarness {
  constructor(
    project: Project,
    sessionStore: SessionStore,
    client: LLMClient,
    toolRegistry: ToolRegistry,
    hookRegistry: HookRegistry,
    systemPrompt: string,
  )

  // Rebuild message history from JSONL, prepend system prompt,
  // create AgentSession, run the loop, persist events.
  async *prompt(userInput: string): AsyncIterable<AgentEvent>
}
```

`prompt()` lifecycle:
1. Rebuild `Message[]` from `SessionStore` (or start fresh).
2. Prepend system prompt as the first message.
3. Append user input.
4. Create or reuse `AgentSession` with the assembled history.
5. `for await (event of session.submit(...))` — yield events to caller.
6. After each `message_end` equivalent (tool_end / turn_end), append the
   persisted message to `SessionStore`.

#### `harness/types.ts`

```ts
interface Project {
  readonly id: string           // named: user-provided; anonymous: encoded cwd
  readonly name: string | null  // null for anonymous projects
  readonly workDir: string      // resolved working directory
  readonly storageDir: string   // ~/.kea/projects/<id>/
}

interface SessionStore {
  append(message: Message): Promise<void>
  load(): Promise<Message[]>
  list(): Promise<string[]>     // session IDs in this project
}
```

#### `harness/session/session.ts`

```ts
// In-memory tree-shaped message history. First version is a flat array;
// tree structure (parentId) comes later with branching support.

class Session {
  constructor(readonly id: string, readonly project: Project)
  get messages(): readonly Message[]
  append(message: Message): void
  toJSON(): object[]   // for JSONL serialization
  static fromJSON(id: string, project: Project, lines: object[]): Session
}
```

#### `harness/session/jsonl-storage.ts`

```ts
// Append-only JSONL file operations. One file per session.

function appendJsonl(path: string, message: Message): Promise<void>
async function* readJsonl(path: string): AsyncIterable<Message>
```

#### `harness/session/session-repo.ts`

```ts
// Organizes session files under ~/.kea/projects/<project-id>/sessions/

class SessionRepo {
  constructor(project: Project)

  // Create a new session file, return its SessionStore
  create(): Promise<SessionStore>

  // Open an existing session by ID
  open(sessionId: string): Promise<SessionStore>

  // List all session IDs for this project
  list(): Promise<string[]>
}
```

#### `harness/messages.ts`

```ts
// Custom message types extending the base Message discriminated union.
// Currently a pass-through; extensibility point for future message types
// (artifacts, notifications, etc.) via declaration merging.

function convertToLlm(messages: AgentMessage[]): Message[]
```

#### `harness/system-prompt.ts`

```ts
// Formats the system prompt. Receives prompt content from the coding layer.
// Future: merge skills lists, prompt templates.

function formatSystemPrompt(content: string): string
```

#### `hooks/` — Generic Hook System

Relocated from `src/hooks/` to `src/agent/hooks/`. No code changes. The hook
system is part of the agent kernel because it operates on tool calls — a
generic agent concept. PermissionHook (which is coding-specific) implements
the generic `Hook<PreToolUseEvent>` interface.

#### `tools/` — Generic Tool Registry

Relocated from `src/tools/types.ts` and `src/tools/registry.ts`. No code
changes. The registry and base `Tool<T>` class are generic — they validate
schemas, dispatch hooks, and manage timeout. They know nothing about bash or
file operations.

### Layer 4: `coding/` — Coding Agent

#### `coding/permission.ts`

Relocated from `src/hooks/builtin/permission.ts`. Implements `Hook<PreToolUseEvent>`.
Contains the three-gate permission pipeline (hard deny → rule matching → user
approval). Imports `blockedBashFragment` from `coding/tools/bash.ts`.

#### `coding/tools/`

Relocated from `src/tools/builtin/`. Concrete tool implementations:
- `bash.ts` — BashTool, `blockedBashFragment()`
- `files.ts` — ReadFileTool, WriteFileTool, EditFileTool
- `glob.ts` — GlobTool
- `factory.ts` — `createToolRegistry(cwd, hooks)` — assembles the default tool set

`workspace.ts` (containing `safePath()`) moves to `src/utils/` because it is a
shared utility consumed by `files.ts` and `glob.ts`, not a tool itself.

### `main.ts` — Composition Root

Thin assembly with clear ordering:

```ts
export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });

  // 1. AI layer
  const client = await createLLMClient();

  // 2. Project
  const project = resolveProject(process.cwd());

  // 3. Coding tools
  const hooks = createHookRegistry([new PermissionHook(...)]);
  const toolRegistry = createToolRegistry(project.workDir, hooks);

  // 4. Harness
  const harness = new AgentHarness(
    project,
    new SessionRepo(project).create(),
    client,
    toolRegistry,
    hooks,
    formatSystemPrompt(CODING_SYSTEM_PROMPT),
  );

  // 5. CLI
  const cli = new CliFrontend();
  await cli.run(harness);
}
```

## Global Storage Layout (`~/.kea/`)

Following Claude Code and Pi agent conventions:

```
~/.kea/
├── settings.json                   # Global app settings
├── history.jsonl                   # Prompt history (up-arrow recall)
└── projects/
    ├── -d-programming-kea_agent/  # Anonymous project (path-encoded)
    │   ├── project.json           #   { name: null, workDir, createdAt }
    │   ├── memory/                #   Per-project auto-memory (future)
    │   └── sessions/
    │       ├── 20260721T183000_abc123.jsonl
    │       └── 20260721T190000_def456.jsonl
    │
    └── my-named-project/          # Named project (user-created)
        ├── project.json           #   { name: "my-named-project", workDir, createdAt }
        ├── memory/
        └── sessions/
            └── 20260721T200000_xyz789.jsonl
```

- **Anonymous project**: ID derived from `cwd` by replacing path separators with `-`
  (e.g., `/d/programming/kea_agent` → `-d-programming-kea_agent`). Created
  automatically when the user runs `kea` in a directory.
- **Named project**: ID is the user-provided name. Can have a custom `workDir`
  independent of the current directory. Created via `kea project create <name>`.
- **`project.json`**: Minimal metadata — `name`, `workDir`, `createdAt`.
- **Sessions**: One JSONL file per session, named `<timestamp>_<uuid>.jsonl`.

## JSONL Session Format

One JSON object per line. The first line is a header; subsequent lines are
messages.

```jsonl
{"type":"session","id":"abc123","cwd":"/d/programming/kea_agent","createdAt":"2026-07-21T18:30:00.000Z"}
{"role":"system","content":"You are a coding agent..."}
{"role":"user","content":"list files"}
{"role":"assistant","content":null,"toolCalls":[{"id":"call-1","name":"bash","arguments":{"command":"ls"}}]}
{"role":"tool","toolCallId":"call-1","name":"bash","content":"src/\ndocs/\npackage.json"}
{"role":"assistant","content":"Here are the files in the project..."}
```

This format is compatible with the existing `Message` discriminated union in
`llm-client/types.ts`.

## Test Migration

Tests move in parallel with source files:

| Current path | New path |
|---|---|
| `tests/agent-turn.test.ts` | `tests/agent/agent-loop.test.ts` |
| `tests/agent-session.test.ts` | `tests/agent/agent-session.test.ts` |
| `tests/hooks/permission.test.ts` | `tests/coding/permission.test.ts` |
| `tests/hooks/registry.test.ts` | `tests/agent/hooks/registry.test.ts` |
| `tests/tools/*.test.ts` | Tests split between `tests/agent/tools/` (registry) and `tests/coding/tools/` (bash, files) |
| `tests/llm-client/*.test.ts` | `tests/llm-client/*.test.ts` (unchanged) |
| `tests/main.test.ts` | `tests/main.test.ts` (updated imports) |
| `tests/import-smoke.test.ts` | `tests/import-smoke.test.ts` (updated imports) |

All tests use `node:test` and `node:assert/strict`. No test contacts a live
provider or reads `.env`.

## Acceptance Criteria

- [ ] TypeScript compilation passes (`npm run typecheck`).
- [ ] All 52 existing tests pass; tests relocated to match new directory structure
  but assertions unchanged.
- [ ] `npm run build` produces correct output in `dist/`.
- [ ] `git diff --check` passes.
- [ ] Import graph respects layer dependency rules (no upward imports).
- [ ] `src/agent/` has zero imports from `src/cli/` or `src/coding/`.
- [ ] `src/agent/harness/` has zero imports from `src/cli/` or `src/coding/`.
- [ ] `src/coding/` has zero imports from `src/cli/`.
- [ ] `src/llm-client/` has zero imports from other `src/` layers except `utils/`.
- [ ] `CliFrontend.requestPermission()` imports `PermissionRequest` from `coding/`
  (intentional seam).
- [ ] No behavioral change to the permission pipeline, tool execution, or agent loop.
