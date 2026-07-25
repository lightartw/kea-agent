# Harness — Agent Runtime

The Harness is the single-threaded runtime core that owns the Agent lifecycle. It internally consumes `AgentEvent`s, persists stable messages into a tree-backed `Session`, and publishes already-persisted events to awaited subscribers.

## Minimal Usage

```ts
import { createStreamFn } from "./ai/factory.js";
import { createHarness } from "./harness/factory.js";

const { stream, defaultModel } = createStreamFn();

const harness = await createHarness({
  project: {
    workDir: process.cwd(),
    storageDir: ".kea/sessions",
  },
  streamFn: stream,
  model: defaultModel,
});

harness.subscribe((event) => {
  // render events (text_delta, tool_start, etc.)
});

await harness.prompt("Write a hello-world program.");
```

## Concept

The Harness is split into two layers:

- **Generic runtime** (`AgentHarness`): owns the Agent, Session, and listeners. It consumes Agent events, persists messages, and publishes to subscribers. It never imports coding tools or the coding system prompt.
- **Coding composition** (`createHarness`): the factory that wires up `AgentHarness` with the coding tool set, coding system prompt, and a filesystem-backed Session. This is the only file that imports concrete tools and `CODING_SYSTEM_PROMPT`.

## `AgentHarness`

The core class. Constructed with `HarnessConfig`:

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `prompt(input: string): Promise<void>` | Runs one agent turn. Persists messages into the Session and publishes Agent events to all subscribers. Resolves when the turn completes. |
| `subscribe(listener: HarnessEventListener): Unsubscribe` | Registers a listener. Returns a function that removes it. |
| `abort(): void` | Requests abort of the running prompt. No-op when idle. |
| `switchModel(model: ModelConfig): Promise<void>` | Persists a model change and updates the current model. Only allowed when idle. |
| `registerTool(tool: AgentTool): void` | Registers a tool for the next run. Only allowed when idle. |
| `unregisterTool(name: string): void` | Removes a tool. Only allowed when idle. |

### Getters

| Getter | Description |
|--------|-------------|
| `messages: readonly AgentMessage[]` | Current conversation history from the Agent. |
| `model: ModelConfig` | Current model config. |
| `isRunning: boolean` | Whether a prompt is in progress. |

### Idle-only mutations

`switchModel()`, `registerTool()`, and `unregisterTool()` throw if called while `isRunning` is `true`. `prompt()` is also rejected if called while running.

## `createHarness`

The coding-agent composition root:

```ts
interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;           // required
  readonly session?: Session;            // reuse an existing session
  readonly systemPrompt?: string | SystemPromptBuilder;
}

interface HarnessProject {
  readonly workDir: string;     // tool cwd + prompt variable
  readonly storageDir: string;  // session JSONL directory
}
```

- `model` is required. Provider/default-model selection is handled by `ai.createStreamFn()`.
- If `session` is omitted, a new `Session.create(storageDir)` is used.
- If `systemPrompt` is a string, it is wrapped via `defaultSystemPrompt()` with `{{cwd}}`/`{{date}}` substitution.
- If `systemPrompt` is a function, it is used directly as a `SystemPromptBuilder`.
- If `systemPrompt` is omitted, `CODING_SYSTEM_PROMPT` is the default.

## Session

Tree-backed JSONL persistence with delayed first write.

### Factories

| Factory | Description |
|---------|-------------|
| `Session.create(storageDir: string): Promise<Session>` | New session with a random ID. |
| `Session.open(storageDir: string, sessionId: string): Promise<Session>` | Reopen a session from disk. |
| `Session.inMemory(): Session` | Ephemeral session for testing. |

### API

| Method | Description |
|--------|-------------|
| `appendMessage(message: AgentMessage): Promise<void>` | Appends a message to the tree. Appends are serialized internally. |
| `appendModelChange(model: ModelConfig): Promise<void>` | Records a model change entry. |
| `buildContext(): SessionContext` | Returns `{ messages, model }` by following the current leaf parent chain. The returned array is a fresh copy. |

### Persistence

- Messages are buffered in memory until the first assistant message is appended.
- The first assistant message creates the JSONL file via `writeFile(path, lines, { flag: "wx" })`.
- Subsequent appends use `appendFile()`.
- On write failure, the entry and its tree links are rolled back.
- `Session.open()` validates every line: ENOENT → `not_found`, empty/bad JSON → `invalid_session`, unknown/malformed entry → `invalid_entry`.

### SessionContext

```ts
interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}
```

### SessionError

```ts
type SessionErrorCode = "not_found" | "invalid_session" | "invalid_entry" | "storage";

class SessionError extends Error {
  readonly code: SessionErrorCode;
}
```

## System Prompt

### `SystemPromptBuilder`

```ts
interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

type SystemPromptBuilder = (ctx: SystemPromptContext) => string | Promise<string>;
```

`SystemPromptBuilder` may be async. `AgentHarness` awaits it before each run.

### Helpers

| Function | Description |
|----------|-------------|
| `formatSystemPrompt(content, options?)` | Replaces `{{cwd}}` and `{{date}}` placeholders. |
| `defaultSystemPrompt(template)` | Wraps a template string into a `SystemPromptBuilder`. |
| `CODING_SYSTEM_PROMPT` | The default coding agent prompt with `{{cwd}}` and `{{date}}`. |

## Tools

### `createToolRegistry(cwd: string): AgentToolRegistry`

Creates a registry with the default tool set in registration order:

1. `BashTool(cwd)` — shell command execution
2. `ReadFileTool(cwd)` — read files
3. `WriteFileTool(cwd)` — create/overwrite files
4. `EditFileTool(cwd)` — exact string replacement
5. `GlobTool(cwd)` — file pattern matching
6. `TodoWriteTool()` — task list management

### `BashTool`

- Owns the single authoritative Bash safety policy.
- Blocks commands containing forbidden fragments: `rm `, `rm -rf /`, `sudo`, `chmod 777`, `shutdown`, `reboot`, `mkfs`, `dd `, `> /etc/`, `> /dev/`.
- Returns `{ content: "Error: Permission denied: <reason>", isError: true }` for blocked commands.
- The policy check runs before invoking the execution backend.
- `BashOperations` interface allows swapping the backend (default: `LocalBashOperations`).

### `TodoWriteTool`

- Todo state is per-instance. Two `TodoWriteTool` instances have independent state.
- No global accessor. State is inspected only through the tool's own `execute()`.

### Other tools

- `ReadFileTool`, `WriteFileTool`, `EditFileTool` — file operations scoped to the workspace.
- `GlobTool` — returns workspace-relative matches.

## Package Boundary

### Imports (from AI/Agent layer)

```ts
// Types consumed from the Agent layer
import type { AgentEvent, AgentMessage } from "../agent/types.js";
import type { AgentTool, AgentToolResult } from "../agent/tools/types.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";

// Types consumed from the AI layer
import type { ModelConfig, StreamFn } from "../ai/types.js";
```

### Exports (to CLI)

```ts
// Classes
export { AgentHarness } from "./agent-harness.js";
export { BashTool } from "./tools/bash.js";
export { LocalBashOperations } from "./tools/bash-ops.js";
export { ReadFileTool, WriteFileTool, EditFileTool } from "./tools/files.js";
export { GlobTool } from "./tools/glob.js";
export { TodoWriteTool } from "./tools/todo-write.js";
export { Session } from "./session/session.js";
export { SessionError } from "./session/types.js";

// Factories
export { createHarness } from "./factory.js";
export { createToolRegistry } from "./tools/factory.js";

// Prompt
export { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
export { defaultSystemPrompt, formatSystemPrompt } from "./system-prompt.js";

// Types
export type { CreateHarnessConfig, HarnessConfig, HarnessEventListener,
  HarnessProject, SystemPromptBuilder, SystemPromptContext,
  Unsubscribe } from "./types.js";
export type { SessionContext, SessionErrorCode } from "./session/types.js";
export type { BashOperations } from "./tools/bash.js";
export type { TodoItem } from "./tools/todo-write.js";
```

## Non-Capabilities

The Harness explicitly does **not** provide:

- Hooks or plugins — the Hook subsystem was removed.
- EventBus — subscribers are direct listeners on the Harness instance.
- Retry, compaction, branching APIs.
- Skills or prompt templates beyond `SystemPromptBuilder`.
- Queues — session appends are internally serialized but not exposed.

The Harness runtime files (`agent-harness.ts`, `types.ts`, `system-prompt.ts`, `session/`) never import concrete coding tools or `CODING_SYSTEM_PROMPT`. Only `factory.ts` composes those defaults.
