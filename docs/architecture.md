# Kea Agent Architecture

**Updated:** 2026-07-21

## Three-Layer Architecture

Kea follows Pi's layered design. Dependencies are strict: each layer only imports
from layers below it.

```
main.ts                    ← composition root

  ├─ cli/                  ← presentation layer
  ├─ harness/              ← application layer (tools, hooks, session persistence)
  ├─ agent/                ← kernel layer (Agent, agent-loop, hooks, tools)
  └─ llm-client/           ← AI abstraction layer
       └─ utils/            ← pure utilities
```

| Layer | Directory | Depends On | What It Provides |
|---|---|---|---|
| Presentation | `cli/` | `agent/`, `harness/` | ANSI rendering, readline I/O |
| Application | `harness/` | `agent/`, `llm-client/` | Built-in tools, hooks, session persistence, AgentHarness |
| Kernel | `agent/` | `llm-client/`, `utils/` | Agent class, pure agent-loop, hook registry, tool registry |
| AI | `llm-client/` | `utils/` | Provider adapters, unified LLMClient |
| Utilities | `utils/` | — | `runWithTimeout()`, `safePath()` |

**Correspondence to Pi:**

| Pi | Kea |
|---|---|
| `runAgentLoop()` | `agent/agent-loop.ts` |
| `Agent` | `agent/agent.ts` |
| `AgentSession` | `harness/agent-harness.ts` |
| `ToolDefinition` | `harness/tools/types.ts` |
| Extension system | `agent/hooks/` + `harness/hooks/` |

## Directory Structure

```
src/
├── main.ts                           # Composition root
│
├── cli/
│   ├── render.ts                     #   renderAgentEvent — pure ANSI function
│   └── frontend.ts                   #   CliFrontend — readline I/O + permission prompt
│
├── harness/                          # Application layer
│   ├── agent-harness.ts              #   AgentHarness(sessionStore, agent) — persistence
│   ├── types.ts                      #   Project, SessionStore interfaces
│   ├── system-prompt.ts              #   formatSystemPrompt()
│   ├── messages.ts                   #   convertToLlm() — extensibility point
│   ├── index.ts                      #   Public exports
│   │
│   ├── session/                      #   Session persistence
│   │   ├── session.ts                #     Session — in-memory history
│   │   ├── jsonl-storage.ts          #     JSONL read/write
│   │   └── session-repo.ts           #     Session file management per project
│   │
│   ├── hooks/                        #   Built-in hook implementations
│   │   ├── factory.ts                #     createHookRegistry(cwd) — 5 built-in hooks
│   │   ├── permission.ts             #     PermissionHook — 3-gate permission pipeline
│   │   ├── context-inject.ts         #     ContextInjectHook — logs working directory
│   │   ├── log.ts                    #     LogHook + LargeOutputHook
│   │   └── summary.ts                #     SummaryHook — tool-call count at session end
│   │
│   └── tools/                        #   Built-in tool implementations
│       ├── types.ts                  #     ToolDefinition<T>, BashOperations
│       ├── adapter.ts                #     wrapToolDefinition(def) → Tool
│       ├── bash.ts                   #     createBashToolDefinition(cwd, ops?)
│       ├── bash-ops.ts               #     LocalBashOperations — local spawn backend
│       ├── files.ts                  #     createReadFileDef, createWriteFileDef, createEditFileDef
│       ├── glob.ts                   #     createGlobDef
│       └── factory.ts                #     createToolRegistry(cwd, hooks?) — 5 built-in tools
│
├── agent/                            # Kernel layer
│   ├── agent.ts                      #   Agent class — owns history + hooks, prompt()
│   ├── agent-loop.ts                 #   runAgentTurn() — pure function, LLM stream + tool loop
│   ├── types.ts                      #   AgentEvent
│   │
│   ├── hooks/                        #   Generic hook system (types + registry only)
│   │   ├── types.ts                  #     HookEvent, Hook<T>, HookResult, 4 event types
│   │   └── registry.ts               #     HookRegistry — register + trigger + get()
│   │
│   └── tools/                        #   Generic tool system
│       ├── types.ts                  #     Tool<T>, ToolResult
│       └── registry.ts               #     ToolRegistry — validate, hooks, timeout, execute
│
├── llm-client/
│   ├── types.ts                      #   Message, LLMResponse, LLMClient, ToolCall, ToolSchema
│   ├── factory.ts                    #   createLLMClient() — provider auto-detection
│   ├── client.ts                     #   mergeOptions()
│   └── adapters/                     #   Anthropic / OpenAI / Gemini adapters
│
└── utils/
    ├── timeout.ts                    #   runWithTimeout(), TimeoutError
    └── workspace.ts                  #   safePath() — lexical workspace path guard
```

## Hook Lifecycle

Four hook events fire during a single `Agent.prompt()` call:

| Order | Event | Trigger Location | Purpose |
|---|---|---|---|
| ① | `user_prompt_submit` | `Agent.prompt()` | Context injection, input validation |
| ② | `pre_tool_use` | `ToolRegistry.execute()` | Permission checks (block before execution) |
| ③ | `post_tool_use` | `ToolRegistry.execute()` | Side effects (logging, output size warnings) |
| ④ | `stop` | `agent-loop.ts: runAgentTurn()` | Summary, compaction, force-continue |

**Processing model:** hooks are called in registration order. The first hook that
returns a non-undefined result stops the chain. Hooks that want to pass through
MUST return undefined.

**Built-in hooks (registered by `createHookRegistry(cwd)`):**

| Hook | Event | Behavior |
|---|---|---|
| `context_inject` | ① | Logs working directory |
| `permission` | ② | 3-gate permission pipeline (hard-deny → rule match → user prompt) |
| `log` | ② | Prints tool name |
| `large_output` | ③ | Warns when output > 100 KB |
| `summary` | ④ | Prints tool-call count |

**HookResult fields by lifecycle:**

| Field | Used By | Effect |
|---|---|---|
| `block`, `reason` | ①, ② | Stop the chain; PreToolUse returns an error to the model |
| `context` | ① | Inject a system message before the user message |
| `messages` | ④ | Replace the entire message history (compaction) |
| `forceContinue` | ④ | Inject a user message and continue the loop instead of stopping |

## Agent and AgentHarness

`Agent` owns the conversation and runs turns. `AgentHarness` wraps it with
persistence:

```ts
// main.ts — initialization (once)
const history = await sessionStore.load();
const messages = history.length === 0
  ? [{ role: "system", content: systemPrompt }]
  : [...history];
const agent = new Agent(client, toolRegistry, hooks, messages);
const harness = new AgentHarness(sessionStore, agent);

// Each user turn
async *harness.prompt(userInput) {
  const historyLength = agent.messages.length;
  yield* agent.prompt(userInput);            // ①→④ hook lifecycle
  for (let i = historyLength; ...) {
    await sessionStore.append(agent.messages[i]); // persist new messages
  }
}
```

`Agent` is created once, not per-turn. Messages accumulate across turns in
`agent.messages`. Like Pi's `Agent`, it is stateful but persistence-agnostic.

## Tool System

Two layers of abstraction, following Pi's pattern:

| Layer | Type | Location | Purpose |
|---|---|---|---|
| Agent-kernel | `Tool<T>` | `agent/tools/types.ts` | LLM-facing schema, validation, execution interface |
| Coding | `ToolDefinition<T>` | `harness/tools/types.ts` | Business logic, future UI rendering hooks |

`wrapToolDefinition()` adapts a `ToolDefinition` into a `Tool`:

```ts
// harness/tools/factory.ts
wrapToolDefinition(createBashToolDefinition(cwd))  // → Tool
wrapToolDefinition(createReadFileDefinition(cwd))   // → Tool
```

Tools in `harness/tools/` never import from `agent/`. They implement
`ToolDefinition`, a plain interface with `name`, `description`, `parameters`,
and `execute()`.

## BashOperations

`BashOperations` is a swappable execution backend for the bash tool:

```ts
// harness/tools/types.ts
interface BashOperations {
  exec(command: string, cwd: string, signal: AbortSignal): Promise<string>;
}
```

`LocalBashOperations` (default) spawns a local child process. Callers can
inject SSH, Docker, or test backends through `createBashToolDefinition(cwd, ops)`.

## Key Design Decisions

**Why ToolCall and ToolSchema live in llm-client.** They are LLM-facing
concepts. The three LLM adapters import them from within their own layer.
`agent/tools/types.ts` re-exports them for convenience.

**Why hooks are split across agent/hooks/ and harness/hooks/.**
`agent/hooks/` defines the generic system (`Hook<T>`, `HookRegistry`,
event types). `harness/hooks/` provides concrete implementations
(`PermissionHook`, `LogHook`, etc.) that know about coding-specific concerns.

**Why hook factory is in harness/, not agent/.**
`agent/hooks/` has no factory — the kernel layer doesn't know which hooks
exist. `harness/hooks/factory.ts` creates the concrete set. Mirrors the
`harness/tools/factory.ts` pattern.

**Why PermissionHook is in harness/, not agent/.**
It knows about bash command fragments and file tools. It is a coding-specific
policy, not generic agent infrastructure.

**Why workspace.ts is in utils/, not harness/tools/.**
`safePath()` is a shared utility consumed by file tools and glob tool. It is
not a Tool — it has no schema, no execute().

## Permission Pipeline

The three-gate pipeline runs inside `PermissionHook` (a `Hook<PreToolUseEvent>`):

1. **Gate 1 — Hard Deny:** Forbidden Bash fragments (`rm -rf /`, `sudo`, etc.)
   blocked permanently. `BashTool.execute()` repeats this check before `spawn()`.
2. **Gate 2 — Rule Matching:** Ordered rules generate approval reasons for
   risky Bash commands and file modifications. The final Bash rule asks for all
   unclassified commands.
3. **Gate 3 — User Approval:** The CLI/TUI adapter presents the request.
   Only `y`/`yes` approves.

## Global Storage (`~/.kea/`)

```text
~/.kea/
├── settings.json
├── history.jsonl
└── projects/
    └── -d-programming-kea_agent/    # Anonymous project (path-encoded from cwd)
        ├── project.json
        ├── memory/
        └── sessions/
            └── 20260721T183000_abc123.jsonl
```

## Design Principles

- **Events ≠ Messages:** `AgentEvent` is ephemeral presentation progress;
  `Message` is durable conversation history.
- **Generic before Specific:** The hook system and tool registry are generic
  kernel infrastructure. Coding-specific hooks and tools plug into them.
- **Factory Pattern:** `createHookRegistry(cwd)` and `createToolRegistry(cwd)`
  auto-register built-in components. Adding a new one is a factory change.
- **Agent owns history, Harness owns persistence.** `Agent` accumulates
  messages across turns; `AgentHarness` writes them to JSONL.
