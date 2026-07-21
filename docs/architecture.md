# Kea Agent Architecture

**Updated:** 2026-07-21

## Layered Architecture

Kea Agent is organized into four layers plus a composition root. The dependency
direction is strict: each layer only imports from layers below it.

```
cli/ ──→ agent/ ──→ llm-client/ ──→ utils/
            ↑
        coding/
```

### Layer Map

| Layer | Directory | Depends On | What It Provides |
|---|---|---|---|
| Presentation | `cli/` | `agent/`, `coding/` | ANSI rendering, readline I/O |
| Coding Agent | `coding/` | `agent/` | Built-in tools, PermissionHook, hook factory |
| Agent Kernel | `agent/` | `llm-client/`, `utils/` | Agent loop, session, harness, hooks, tool registry |
| AI Abstraction | `llm-client/` | `utils/` | Provider adapters, unified LLMClient, shared types |
| Utilities | `utils/` | — | timeout, workspace path safety |

## Directory Structure

```
src/
├── main.ts                         # Composition root — wires everything together
│
├── cli/                            # Layer 1: Presentation
│   ├── render.ts                   #   renderAgentEvent — pure ANSI function
│   └── frontend.ts                 #   CliFrontend — readline I/O + session loop
│
├── llm-client/                     # Layer 2: AI Abstraction
│   ├── types.ts                    #   Message, LLMResponse, LLMClient, ToolCall, ToolSchema
│   ├── factory.ts                  #   createLLMClient() — provider auto-detection
│   ├── client.ts                   #   mergeOptions()
│   └── adapters/                   #   Anthropic / OpenAI / Gemini adapters
│
├── agent/                          # Layer 3: Agent Kernel
│   ├── agent-loop.ts               #   runAgentTurn — pure async generator
│   ├── agent-session.ts            #   AgentSession — history + submit()
│   │
│   ├── harness/                    #   Middle infrastructure (tool-agnostic, UI-agnostic)
│   │   ├── agent-harness.ts        #     Wraps loop: project + sessions + system prompt
│   │   ├── types.ts                #     Project, SessionStore interfaces
│   │   ├── messages.ts             #     convertToLlm() — extensibility point
│   │   ├── system-prompt.ts        #     formatSystemPrompt()
│   │   └── session/                #     Session persistence
│   │       ├── session.ts          #       Session — in-memory history
│   │       ├── jsonl-storage.ts    #       JSONL read/write
│   │       └── session-repo.ts     #       Session file management per project
│   │
│   ├── hooks/                      #   Generic hook system (types + registry only; factory in coding/)
│   │   ├── types.ts                #     HookEvent, PreToolUseEvent, Hook<T>, HookResult
│   │   └── registry.ts             #     HookRegistry — register + trigger + get()
│   │
│   └── tools/                      #   Generic tool types + registry
│       ├── types.ts                #     Tool<T>, ToolResult
│       └── registry.ts             #     ToolRegistry — validate, hook gate, timeout, execute
│
├── coding/                         # Layer 4: Coding Agent specifics
│   ├── hooks/                      #   Built-in hooks (mirrors tools/ structure)
│   │   ├── factory.ts              #     createHookRegistry()
│   │   └── permission.ts           #     PermissionHook — 3-gate permission pipeline
│   └── tools/                      #   Built-in coding tools
│       ├── bash.ts                 #     BashTool — shell command execution
│       ├── files.ts                #     ReadFileTool, WriteFileTool, EditFileTool
│       ├── glob.ts                 #     GlobTool — file pattern matching
│       └── factory.ts              #     createToolRegistry() — assembles default tool set
│
└── utils/
    ├── timeout.ts                  #   runWithTimeout(), TimeoutError
    └── workspace.ts               #   safePath() — lexical workspace path guard
```

## Key Design Decisions

### Why ToolCall and ToolSchema live in llm-client

`ToolCall` and `ToolSchema` are LLM-facing concepts — the tool schema format sent
to providers and the tool calls returned by them. They are defined in
`llm-client/types.ts` (Layer 2) and re-exported by `agent/tools/types.ts` (Layer 3)
so that agent-level consumers see no change. The three LLM adapters import them
directly from `../types.js` within their own layer, preserving the correct
dependency direction.

### Why PermissionHook is in coding/, not agent/hooks/

PermissionHook knows about bash commands (`blockedBashFragment`) and file tools
(`write_file`, `edit_file`). It is a coding-specific policy, not a generic
agent hook. The generic hook system (`agent/hooks/`) only knows about
`Hook<TEvent>`, `HookRegistry`, and `PreToolUseEvent` — it has no opinion on
what hooks do.

### Why main.ts doesn't construct hooks or tools directly

`main.ts` calls two factories:
- `createHookRegistry([new PermissionHook()])` — builds the hook pipeline from
  concrete hooks. Adding a hook means adding one array element here.
- `createToolRegistry(cwd, hooks)` — registers BashTool, file tools, GlobTool
  without main.ts knowing which tools exist.

No redundant "default" wrappers.

### Why workspace.ts is in utils/, not coding/tools/

`safePath()` is a shared utility consumed by `files.ts` and `glob.ts`. It is not
a Tool — it has no schema, no execute(), and does not implement `Tool<T>`.
Placing it in `utils/` keeps the dependency graph clean: tools import from
utils, not from each other.

### Harness: Agent vs. AgentHarness vs. AgentSession

| Component | Location | Knows About | Doesn't Know |
|---|---|---|---|
| `runAgentTurn` | `agent/agent-loop.ts` | Messages → LLM → tools → loop | Sessions, JSONL, projects, system prompts |
| `AgentHarness` | `agent/harness/` | Projects, session persistence, system prompt assembly | Bash, files, CLI, TUI, specific tools |
| `AgentSession` | `agent/agent-session.ts` | Message history, one active submission | JSONL files, project paths, system prompts |

The harness is the middle layer — it adds infrastructure (persistence, projects)
to the pure agent loop, but remains tool-agnostic and UI-agnostic.

## Global Storage Layout (`~/.kea/`)

```
~/.kea/
├── settings.json                   # Global app settings
├── history.jsonl                   # Prompt history (up-arrow recall)
└── projects/
    ├── -d-programming-kea_agent/  # Anonymous project (path-encoded)
    │   ├── project.json           #   { name: null, workDir, createdAt }
    │   ├── memory/                #   Per-project auto-memory (future)
    │   └── sessions/
    │       └── 20260721T183000_abc123.jsonl
    │
    └── my-named-project/          # Named project (user-created)
        ├── project.json           #   { name: "my-named-project", workDir, createdAt }
        ├── memory/
        └── sessions/
            └── 20260721T200000_xyz789.jsonl
```

- **Anonymous project:** ID derived from `cwd` by replacing path separators with `-`
- **Named project:** ID is user-provided; can have custom `workDir`
- **Sessions:** One JSONL file per session, named `<timestamp>_<uuid>.jsonl`

## Permission Pipeline

The three-gate pipeline runs inside `PermissionHook` (a `Hook<PreToolUseEvent>`):

1. **Gate 1 — Hard Deny:** Forbidden Bash fragments (`rm -rf /`, `sudo`, etc.)
   are blocked permanently. BashTool repeats this check before `spawn()`.
2. **Gate 2 — Rule Matching:** Ordered rules generate approval reasons for
   risky Bash commands and file modifications. The final Bash rule asks for all
   unclassified commands as a safe default.
3. **Gate 3 — User Approval:** The CLI/TUI adapter presents the request and
   collects the user's decision. Only `y`/`yes` approves.

The permission system is a guardrail against accidental damage, not a sandbox.

## Design Principles

- **Events ≠ Messages:** `AgentEvent` is ephemeral presentation progress;
  `Message` is durable conversation history sent to the model.
- **Generic before Specific:** The hook system and tool registry are generic
  agent infrastructure. Coding-specific hooks and tools plug into them.
- **Factory Pattern:** Composition root calls factories (`createLLMClient`,
  `createHookRegistry`, `createToolRegistry`) rather than constructing
  instances directly. Adding a new built-in component is a factory change.
- **YAGNI:** Compaction, tree navigation, skills, prompt templates, ExecutionEnv,
  and the extension system are absent. They are future harness features, not
  premature abstractions.
