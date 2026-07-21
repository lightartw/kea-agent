# Layered Architecture Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` into four layered directories (`cli/`, `agent/`, `llm-client/`, `coding/`) with an `agent/harness/` middle layer, split `cli.ts`, move `PermissionHook` to `coding/`, and add project/session infrastructure — all without behavioral changes.

**Architecture:** Pure file migration with import-path updates. `ToolCall` and `ToolSchema` (LLM-facing types) move from `tools/types.ts` into `llm-client/types.ts` to preserve the `agent → llm-client` dependency direction. `agent/tools/types.ts` re-exports them so existing consumers see no change. New harness files are minimal, compilable stubs.

**Tech Stack:** TypeScript 7.0, Node.js 24, TypeBox 1.3.6, node:test

## Global Constraints

- `cli/` → `agent/` → `llm-client/` → `utils/` dependency direction; `coding/` → `agent/`.
- No behavioral changes — permission pipeline, tool execution, agent loop unchanged.
- 52 existing tests must pass after migration; imports updated, assertions unchanged.
- `npm run typecheck` must succeed; `npm run build` must produce valid dist/.
- `workspace.ts` lives in `utils/` (it is a shared helper, not a tool).
- `ToolCall` and `ToolSchema` are defined in `llm-client/types.ts`; `agent/tools/types.ts` re-exports them.

---

### Task 1: Create new directory structure

**Files:**
- Create: `src/agent/harness/session/` (nested dirs)
- Create: `src/agent/hooks/`
- Create: `src/agent/tools/`
- Create: `src/cli/`
- Create: `src/coding/tools/`

No file edits — create directories only.

- [ ] **Step 1: Create all directories**

```bash
mkdir -p src/agent/harness/session
mkdir -p src/agent/hooks
mkdir -p src/agent/tools
mkdir -p src/cli
mkdir -p src/coding/tools
```

- [ ] **Step 2: Verify directories exist**

```bash
ls -d src/agent/harness/session src/agent/hooks src/agent/tools src/cli src/coding/tools
```

All five paths should exist.

- [ ] **Step 3: Commit**

```bash
git add src/agent/ src/cli/ src/coding/
git commit -m "chore: create layered directory structure"
```

---

### Task 2: Move ToolCall / ToolSchema types into llm-client (fix layering before migration)

**Files:**
- Modify: `src/llm-client/types.ts`
- Modify: `src/llm-client/adapters/anthropic.ts`
- Modify: `src/llm-client/adapters/openai.ts`
- Modify: `src/llm-client/adapters/gemini.ts`
- Modify: `src/tools/types.ts`

**Rationale:** `ToolCall` and `ToolSchema` are LLM-facing concepts (tool schema format sent to providers, tool calls returned by providers). They currently live in `tools/types.ts`, forcing `llm-client/` to import from `tools/`. Moving them into `llm-client/types.ts` fixes the dependency direction before the directory restructure.

**Interfaces:**
- Consumes: Current `ToolCall`, `ToolSchema` definitions in `src/tools/types.ts`
- Produces: `ToolCall`, `ToolSchema` defined in `llm-client/types.ts`; `agent/tools/types.ts` imports and re-exports them

- [ ] **Step 1: Read current ToolCall and ToolSchema definitions**

Read `src/tools/types.ts` lines 5-19 — these are `ToolSchema` (lines 5-12) and `ToolCall` (lines 14-19).

- [ ] **Step 2: Add ToolCall and ToolSchema to llm-client/types.ts**

Edit `src/llm-client/types.ts`: remove the existing `import type { ToolCall, ToolSchema } from "../tools/types.js"` line (line 1), and inline the type definitions there before the existing `Message` interface:

```ts
// src/llm-client/types.ts — after edit

/** The OpenAI-style definition sent to every LLM provider. */
export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** A model request for the registry to run one tool. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

// ... rest of file unchanged: FinishReason, Message, TokenUsage, LLMResponse, etc.
```

Use two `Edit` calls:
1. Replace `import type { ToolCall, ToolSchema } from "../tools/types.js";` with the two interface definitions above.
2. The rest of the file stays the same.

- [ ] **Step 3: Update llm-client adapter imports**

Each adapter currently imports `ToolCall, ToolSchema from "../../tools/types.js"`. Change each to import from `"../types.js"`:

Edit `src/llm-client/adapters/anthropic.ts` line 14:
```
- import type { ToolCall, ToolSchema } from "../../tools/types.js";
+ import type { ToolCall, ToolSchema } from "../types.js";
```

Edit `src/llm-client/adapters/openai.ts` line 14:
```
- import type { ToolCall, ToolSchema } from "../../tools/types.js";
+ import type { ToolCall, ToolSchema } from "../types.js";
```

Edit `src/llm-client/adapters/gemini.ts` line 14:
```
- import type { ToolCall, ToolSchema } from "../../tools/types.js";
+ import type { ToolCall, ToolSchema } from "../types.js";
```

- [ ] **Step 4: Update tools/types.ts — import and re-export ToolCall/ToolSchema from llm-client**

Edit `src/tools/types.ts`: remove the inline `ToolSchema` and `ToolCall` definitions (lines 5-19), add imports:

```ts
import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";

// Re-export LLM-facing types from the layer that owns them.
import type { ToolCall, ToolSchema } from "../llm-client/types.js";
export type { ToolCall, ToolSchema };

/** The registry's result, returned to both the model and the terminal. */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** A tool describes itself to the model and executes one validated call. */
export abstract class Tool<TParameters extends TObject = TObject> {
  // ... unchanged
}
```

Use Edit to:
1. Remove the `ToolSchema` interface block (lines 5-12)
2. Remove the `ToolCall` interface block (lines 14-19)
3. Add the import/re-export lines right after the typebox imports

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```

Expected: success, no errors. The types are still exported from `tools/types.ts`, all consumers see no difference.

- [ ] **Step 6: Commit**

```bash
git add src/llm-client/types.ts src/llm-client/adapters/ src/tools/types.ts
git commit -m "refactor: move ToolCall/ToolSchema into llm-client layer"
```

---

### Task 3: Move agent kernel files (agent-loop, agent-session, hooks, tools registry)

**Files:**
- Move: `src/agent-turn.ts` → `src/agent/agent-loop.ts`
- Move: `src/agent-session.ts` → `src/agent/agent-session.ts`
- Move: `src/hooks/types.ts` → `src/agent/hooks/types.ts`
- Move: `src/hooks/registry.ts` → `src/agent/hooks/registry.ts`
- Move: `src/hooks/factory.ts` → `src/agent/hooks/factory.ts`
- Move: `src/hooks/index.ts` → `src/agent/hooks/index.ts`
- Move: `src/tools/registry.ts` → `src/agent/tools/registry.ts`
- Move: `src/tools/types.ts` → `src/agent/tools/types.ts`
- Delete: `src/tools/index.ts` (split in later task)
- Modify: `src/index.ts` (update barrel)

**Every moved file needs import-path fixes.** Use Git move (`git mv`) to preserve history.

- [ ] **Step 1: Move agent-loop.ts and fix imports**

```bash
git mv src/agent-turn.ts src/agent/agent-loop.ts
```

Then edit `src/agent/agent-loop.ts` — update relative imports:

```
- import { ... } from "./llm-client/types.js";
+ import { ... } from "../llm-client/types.js";

- import type { ToolCall, ToolResult } from "./tools/types.js";
+ import type { ToolCall, ToolResult } from "./tools/types.js";  // same level now, no change

- import type { ToolRegistry } from "./tools/registry.js";
+ import type { ToolRegistry } from "./tools/registry.js";  // same level now, no change
```

Only the llm-client import changes (from `./llm-client/` to `../llm-client/`).

- [ ] **Step 2: Move agent-session.ts and fix imports**

```bash
git mv src/agent-session.ts src/agent/agent-session.ts
```

Edit `src/agent/agent-session.ts` — update imports:

```ts
// Before:
import { runAgentTurn, type AgentEvent } from "./agent-turn.js";
import type { LLMClient, Message } from "./llm-client/types.js";
import type { ToolRegistry } from "./tools/registry.js";

// After:
import { runAgentTurn, type AgentEvent } from "./agent-loop.js";
import type { LLMClient, Message } from "../llm-client/types.js";
import type { ToolRegistry } from "./tools/registry.js";
```

- [ ] **Step 3: Move hooks/ files and fix imports**

```bash
git mv src/hooks/types.ts src/agent/hooks/types.ts
git mv src/hooks/registry.ts src/agent/hooks/registry.ts
git mv src/hooks/factory.ts src/agent/hooks/factory.ts
git mv src/hooks/index.ts src/agent/hooks/index.ts
```

Edit `src/agent/hooks/types.ts` — update import:

```
- import type { ToolCall } from "../tools/types.js";
+ import type { ToolCall } from "../tools/types.js";  // same relative depth, no change needed
```

Wait — `hooks/types.ts` is going from `src/hooks/types.ts` to `src/agent/hooks/types.ts`. The import `"../tools/types.js"` from `src/hooks/` resolves to `src/tools/types.ts`. From `src/agent/hooks/`, `"../tools/types.js"` resolves to `src/agent/tools/types.ts`. Same relative depth — no change needed!

Edit `src/agent/hooks/index.ts`:

```
- export * from "./builtin/permission.js";
+ // PermissionHook moved to coding/; coding layer registers it.
  export * from "./factory.js";
  export * from "./registry.js";
  export * from "./types.js";
```

Remove the permission re-export line (it's moved to coding/ in a later task).

`src/agent/hooks/registry.ts` and `src/agent/hooks/factory.ts` — their imports (`./types.js`, `./registry.js`) stay the same since they're in the same directory.

- [ ] **Step 4: Move tools/types.ts and tools/registry.ts**

```bash
git mv src/tools/types.ts src/agent/tools/types.ts
git mv src/tools/registry.ts src/agent/tools/registry.ts
```

Edit `src/agent/tools/types.ts` — update the llm-client import:

```ts
// Before:
import type { ToolCall, ToolSchema } from "../llm-client/types.js";

// After (going from src/tools/ to src/agent/tools/):
import type { ToolCall, ToolSchema } from "../../llm-client/types.js";
```

Edit `src/agent/tools/registry.ts` — update imports:

```ts
// Before:
import type { HookRegistry } from "../hooks/registry.js";
import { runWithTimeout, timeoutMilliseconds } from "../utils/timeout.js";
import { Tool, type ToolCall, type ToolResult, type ToolSchema } from "./types.js";

// After:
import type { HookRegistry } from "../hooks/registry.js";
import { runWithTimeout, timeoutMilliseconds } from "../../utils/timeout.js";
import { Tool, type ToolCall, type ToolResult, type ToolSchema } from "./types.js";
```

- [ ] **Step 5: Delete old empty directories**

```bash
rmdir src/hooks/builtin 2>/dev/null || true   # permission.ts was here, moved later
rmdir src/hooks 2>/dev/null || true            # may fail if builtin not empty yet
rmdir src/tools/builtin 2>/dev/null || true    # tool files moved later
```

Note: if rmdir fails because files remain, it's OK — later tasks will clean up.

- [ ] **Step 6: Verify typecheck**

```bash
npm run typecheck
```

Expected: failures due to consumers still importing from old paths. This is expected — we'll fix consumers in subsequent tasks.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move agent kernel files to agent/ directory"
```

---

### Task 4: Move coding tool implementations (bash, files, glob, workspace, factory)

**Files:**
- Move: `src/tools/builtin/bash.ts` → `src/coding/tools/bash.ts`
- Move: `src/tools/builtin/files.ts` → `src/coding/tools/files.ts`
- Move: `src/tools/builtin/glob.ts` → `src/coding/tools/glob.ts`
- Move: `src/tools/builtin/workspace.ts` → `src/utils/workspace.ts`
- Move: `src/tools/factory.ts` → `src/coding/tools/factory.ts`
- Move: `src/hooks/builtin/permission.ts` → `src/coding/permission.ts`

- [ ] **Step 1: Move bash.ts and fix imports**

```bash
git mv src/tools/builtin/bash.ts src/coding/tools/bash.ts
```

Edit `src/coding/tools/bash.ts` — update import:

```ts
// Before:
import { Tool } from "../types.js";

// After (going from src/tools/builtin/ to src/coding/tools/):
import { Tool } from "../../agent/tools/types.js";
```

- [ ] **Step 2: Move files.ts and fix imports**

```bash
git mv src/tools/builtin/files.ts src/coding/tools/files.ts
```

Edit `src/coding/tools/files.ts`:

```ts
// Before:
import { Tool } from "../types.js";
import { safePath } from "./workspace.js";

// After:
import { Tool } from "../../agent/tools/types.js";
import { safePath } from "../../utils/workspace.js";
```

- [ ] **Step 3: Move glob.ts and fix imports**

```bash
git mv src/tools/builtin/glob.ts src/coding/tools/glob.ts
```

Edit `src/coding/tools/glob.ts`:

```ts
// Before:
import { Tool } from "../types.js";
import { safePath } from "./workspace.js";

// After:
import { Tool } from "../../agent/tools/types.js";
import { safePath } from "../../utils/workspace.js";
```

- [ ] **Step 4: Move workspace.ts to utils/**

```bash
git mv src/tools/builtin/workspace.ts src/utils/workspace.ts
```

No import changes — `workspace.ts` has no internal imports (only `node:path`).

- [ ] **Step 5: Move factory.ts and fix imports**

```bash
git mv src/tools/factory.ts src/coding/tools/factory.ts
```

Edit `src/coding/tools/factory.ts`:

```ts
// Before:
import type { HookRegistry } from "../hooks/registry.js";
import { BashTool } from "./builtin/bash.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./builtin/files.js";
import { GlobTool } from "./builtin/glob.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

// After:
import type { HookRegistry } from "../../agent/hooks/registry.js";
import { BashTool } from "./bash.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./files.js";
import { GlobTool } from "./glob.js";
import { ToolRegistry } from "../../agent/tools/registry.js";
import type { Tool } from "../../agent/tools/types.js";
```

- [ ] **Step 6: Move permission.ts and fix imports**

```bash
git mv src/hooks/builtin/permission.ts src/coding/permission.ts
```

Edit `src/coding/permission.ts`:

```ts
// Before:
import { blockedBashFragment } from "../../tools/builtin/bash.js";
import type { ToolCall } from "../../tools/types.js";
import type { Hook, HookResult, PreToolUseEvent } from "../types.js";

// After:
import { blockedBashFragment } from "./tools/bash.js";
import type { ToolCall } from "../agent/tools/types.js";
import type { Hook, HookResult, PreToolUseEvent } from "../agent/hooks/types.js";
```

- [ ] **Step 7: Clean up old empty directories**

```bash
rmdir src/tools/builtin 2>/dev/null || true
rmdir src/tools 2>/dev/null || true
rmdir src/hooks/builtin 2>/dev/null || true
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: move coding tools and permission to coding/ directory"
```

---

### Task 5: Split cli.ts into render.ts and frontend.ts

**Files:**
- Create: `src/cli/render.ts` — pure ANSI rendering functions
- Create: `src/cli/frontend.ts` — CliFrontend class (readline I/O)
- Delete: `src/cli.ts` (after split)

- [ ] **Step 1: Create src/cli/render.ts**

Extract the `renderAgentEvent` function and its constants (CYAN, RESET). The file has no knowledge of readline or session loops.

```ts
import type { AgentEvent } from "../agent/agent-loop.js";

const CYAN = "[36m";
const RESET = "[0m";

/** Convert presentation-neutral agent events into the current line-based UI. */
export function renderAgentEvent(
  event: AgentEvent,
  write: (text: string) => void,
  log: (text: string) => void,
): void {
  if (event.type === "text_delta") {
    write(event.text);
  } else if (event.type === "tool_start") {
    log(
      `\n[33m[tool] $ ${event.call.name}: ${JSON.stringify(event.call.arguments)}[0m`,
    );
  } else if (event.type === "tool_end") {
    const label = event.result.isError ? "[31m[tool error]" : "[90m[tool result]";
    log(`${label} ${event.call.name}[0m\n${event.result.content.slice(0, 200)}`);
  }
}
```

- [ ] **Step 2: Create src/cli/frontend.ts**

Write the `CliFrontend` class. Imports `renderAgentEvent` from `./render.js`, agent types from `../agent/`, and `PermissionRequest` from `../coding/permission.js`.

```ts
import { createInterface, type Interface } from "node:readline/promises";

import type { AgentEvent } from "../agent/agent-loop.js";
import type { AgentSession } from "../agent/agent-session.js";
import type { PermissionRequest } from "../coding/permission.js";
import { renderAgentEvent } from "./render.js";

const CYAN = "[36m";
const RESET = "[0m";

/** The readline presentation adapter; core modules never import this class. */
export class CliFrontend {
  private readonly readline: Interface;

  constructor() {
    this.readline = createInterface({ input: process.stdin, output: process.stdout });
    this.readline.on("SIGINT", () => {
      this.readline.close();
    });
  }

  /** Show one approval request. EOF and Ctrl+C are denials, not approvals. */
  async requestPermission(request: PermissionRequest): Promise<boolean> {
    console.log(`\n[33m[permission] ${request.reason}[0m`);
    console.log(`  ${request.call.name}: ${JSON.stringify(request.call.arguments)}`);
    try {
      const answer = await this.readline.question("  Allow? [y/N] ");
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } catch {
      return false;
    }
  }

  /** Keep accepting user turns while AgentSession owns conversation state. */
  async run(session: AgentSession): Promise<void> {
    console.log("s01: Agent Loop");
    console.log("输入问题，回车发送。输入 q 退出。\n");
    while (true) {
      let query: string;
      try {
        query = await this.readline.question(`${CYAN}s01 >> ${RESET}`);
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

      for await (const event of session.submit(query)) {
        renderAgentEvent(
          event,
          (text) => process.stdout.write(text),
          (text) => console.log(text),
        );
      }
      console.log();
    }
  }

  /** Safe to call after normal exit, Ctrl+C, or startup failure. */
  close(): void {
    this.readline.close();
  }
}
```

- [ ] **Step 3: Delete old src/cli.ts**

```bash
git rm src/cli.ts
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: split cli into render.ts and frontend.ts"
```

---

### Task 6: Create harness files (minimal, compilable stubs)

**Files:**
- Create: `src/agent/harness/types.ts`
- Create: `src/agent/harness/messages.ts`
- Create: `src/agent/harness/system-prompt.ts`
- Create: `src/agent/harness/session/session.ts`
- Create: `src/agent/harness/session/jsonl-storage.ts`
- Create: `src/agent/harness/session/session-repo.ts`
- Create: `src/agent/harness/agent-harness.ts`

All harness files are minimal, compilable stubs. They provide the scaffolding without implementing full persistence logic yet.

- [ ] **Step 1: Create src/agent/harness/types.ts**

```ts
import type { Message } from "../../llm-client/types.js";

/** A project groups sessions and owns a working directory. */
export interface Project {
  readonly id: string;
  /** null for anonymous (path-encoded) projects. */
  readonly name: string | null;
  readonly workDir: string;
  readonly storageDir: string;
}

/** Persistence contract for one session; SessionRepo creates implementations. */
export interface SessionStore {
  append(message: Message): Promise<void>;
  load(): Promise<Message[]>;
}
```

- [ ] **Step 2: Create src/agent/harness/messages.ts**

```ts
import type { Message } from "../../llm-client/types.js";

/**
 * Convert agent-level messages to LLM-consumable messages.
 * Currently a pass-through; extensibility point for custom message types
 * via declaration merging in the future.
 */
export function convertToLlm(messages: readonly Message[]): Message[] {
  return [...messages];
}
```

- [ ] **Step 3: Create src/agent/harness/system-prompt.ts**

```ts
/**
 * Format a system prompt for the LLM context window.
 * Future: merge skills lists, prompt templates, date/time placeholders.
 */
export function formatSystemPrompt(content: string): string {
  return content;
}
```

- [ ] **Step 4: Create src/agent/harness/session/session.ts**

```ts
import type { Message } from "../../../llm-client/types.js";

/**
 * In-memory message history for one session.
 * First version is a flat array; tree structure (parentId) later.
 */
export class Session {
  constructor(
    readonly id: string,
    private messages: Message[] = [],
  ) {}

  getMessages(): readonly Message[] {
    return this.messages;
  }

  append(message: Message): void {
    this.messages.push(message);
  }

  /** Serialize for JSONL persistence. */
  toJSON(): object[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** Deserialize from parsed JSONL lines. */
  static fromJSON(id: string, lines: object[]): Session {
    return new Session(id, lines as Message[]);
  }
}
```

- [ ] **Step 5: Create src/agent/harness/session/jsonl-storage.ts**

```ts
import { appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Message } from "../../../llm-client/types.js";

/** Append one message line to a JSONL session file. */
export async function appendJsonl(
  path: string,
  message: Message,
): Promise<void> {
  await appendFile(path, JSON.stringify(message) + "\n", "utf8");
}

/** Read all messages from a JSONL session file. Returns [] for missing files. */
export async function readJsonl(path: string): Promise<Message[]> {
  const messages: Message[] = [];
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        messages.push(JSON.parse(line) as Message);
      }
    }
  } catch (error) {
    // File not found is normal for fresh sessions.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return messages;
}
```

- [ ] **Step 6: Create src/agent/harness/session/session-repo.ts**

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "../../../llm-client/types.js";
import type { Project, SessionStore } from "../types.js";
import { appendJsonl, readJsonl } from "./jsonl-storage.js";

function sessionsDir(project: Project): string {
  return join(project.storageDir, "sessions");
}

function sessionPath(project: Project, sessionId: string): string {
  return join(sessionsDir(project), `${sessionId}.jsonl`);
}

function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

/** Manages JSONL session files under ~/.kea/projects/<id>/sessions/. */
export class SessionRepo {
  constructor(private readonly project: Project) {}

  /** Create a new empty session, ready for messages to be appended. */
  async create(): Promise<SessionStore> {
    await mkdir(sessionsDir(this.project), { recursive: true });
    const id = newSessionId();
    const path = sessionPath(this.project, id);
    const messages: Message[] = [];
    // Write a header line so the file exists.
    await appendJsonl(path, {
      role: "system",
      content: `session:${id}`,
    } as Message);
    return {
      append: async (message: Message) => {
        messages.push(message);
        await appendJsonl(path, message);
      },
      load: async () => {
        return (await readJsonl(path)).slice(1); // skip header
      },
    };
  }

  /** Open existing session by ID. */
  async open(sessionId: string): Promise<SessionStore> {
    const path = sessionPath(this.project, sessionId);
    const stored = await readJsonl(path);
    const messages = stored.slice(1); // skip header
    return {
      append: async (message: Message) => {
        messages.push(message);
        await appendJsonl(path, message);
      },
      load: async () => [...messages],
    };
  }
}
```

- [ ] **Step 7: Create src/agent/harness/agent-harness.ts**

```ts
import { AgentSession } from "../agent-session.js";
import type { LLMClient } from "../../llm-client/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { AgentEvent } from "../agent-loop.js";
import type { Project, SessionStore } from "./types.js";
import { formatSystemPrompt } from "./system-prompt.js";

/**
 * Middle infrastructure layer. Wraps AgentSession with project context,
 * session persistence, and system prompt assembly. Tool-agnostic and UI-agnostic.
 */
export class AgentHarness {
  constructor(
    private readonly project: Project,
    private readonly sessionStore: SessionStore,
    private readonly client: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly hookRegistry: HookRegistry,
    private readonly systemPromptContent: string,
  ) {}

  /**
   * Run one user prompt through the agent loop. Rebuilds history from the
   * session store, injects the system prompt on first use, runs the loop,
   * and appends all new messages to the store.
   */
  async *prompt(userInput: string): AsyncIterable<AgentEvent> {
    // 1. Load existing history from session store.
    const history = await this.sessionStore.load();

    // 2. Prepend system prompt if this is a fresh session.
    const messages = history.length === 0
      ? [{ role: "system" as const, content: formatSystemPrompt(this.systemPromptContent) }]
      : [...history];

    // 3. Create AgentSession with the assembled history.
    const session = new AgentSession(this.client, this.toolRegistry, messages);

    // 4. Run the agent turn — yield events for the UI.
    for await (const event of session.submit(userInput)) {
      yield event;
    }

    // 5. Persist all messages from this completed turn.
    for (const msg of session.messages) {
      await this.sessionStore.append(msg);
    }
  }
}
```

- [ ] **Step 8: Verify typecheck**

```bash
npm run typecheck
```

Expected: may have errors from main.ts and tests still referencing old paths. These are fixed in subsequent tasks.

- [ ] **Step 9: Commit**

```bash
git add src/agent/harness/
git commit -m "feat: add AgentHarness with project/session infrastructure"
```

---

### Task 7: Update barrel exports (index.ts files)

**Files:**
- Modify: `src/index.ts`
- Create: `src/coding/tools/index.ts` (barrel for coding tools)
- Modify: `src/agent/tools/index.ts` (was `src/tools/index.ts` — already moved)

- [ ] **Step 1: Update src/index.ts**

```ts
export * from "./agent/agent-loop.js";
export * from "./agent/agent-session.js";
export * from "./agent/hooks/index.js";
export * from "./agent/tools/index.js";
export * from "./agent/harness/agent-harness.js";
export * from "./agent/harness/types.js";
export * from "./llm-client/index.js";
export * from "./utils/timeout.js";
export * from "./utils/workspace.js";
```

- [ ] **Step 2: Create src/agent/tools/index.ts**

The old `tools/index.ts` exported everything including builtin tools. The new `agent/tools/index.ts` exports only the generic kernel:

```ts
export * from "./types.js";
export * from "./registry.js";
```

- [ ] **Step 3: Create src/coding/tools/index.ts**

```ts
export * from "./bash.js";
export * from "./files.js";
export * from "./glob.js";
export * from "./factory.js";
```

- [ ] **Step 4: Update src/agent/hooks/index.ts** (fix if not already done in Task 3)

Ensure it does NOT export `permission.js`:

```ts
export * from "./factory.js";
export * from "./registry.js";
export * from "./types.js";
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update barrel exports for new directory structure"
```

---

### Task 8: Rewrite main.ts as thin composition root

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Rewrite src/main.ts**

```ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

import { config as loadDotenv } from "dotenv";

import { AgentHarness } from "./agent/harness/agent-harness.js";
import { SessionRepo } from "./agent/harness/session/session-repo.js";
import type { Project } from "./agent/harness/types.js";
import { createHookRegistry } from "./agent/hooks/factory.js";
import { CliFrontend } from "./cli/frontend.js";
import { PermissionHook } from "./coding/permission.js";
import { createToolRegistry } from "./coding/tools/factory.js";
import { createLLMClient } from "./llm-client/factory.js";
import { formatSystemPrompt } from "./agent/harness/system-prompt.js";

const CODING_SYSTEM_PROMPT = `You are a coding agent. Use bash, read_file, write_file, edit_file, and glob to solve tasks. Act, don't explain.`;

function resolveProject(cwd: string): Project {
  // Encode path as ID: /d/programming/kea_agent → -d-programming-kea_agent
  const id = cwd.replace(/^([A-Za-z]):/, "-$1").replace(/[/\\]/g, "-");
  const storageRoot = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
  return {
    id,
    name: null, // anonymous project; named projects added later
    workDir: cwd,
    storageDir: resolve(storageRoot, "projects", id),
  };
}

/**
 * Node process composition root. Environment loading and concrete adapters stay
 * here so AgentSession, the agent loop, and hooks remain presentation-neutral.
 */
export async function asyncMain(): Promise<void> {
  loadDotenv({ override: true });
  const cli = new CliFrontend();
  try {
    // 1. AI layer
    const client = await createLLMClient();

    // 2. Project (anonymous by default, from cwd)
    const project = resolveProject(process.cwd());

    // 3. Coding-specific hooks and tools
    const hooks = createHookRegistry([
      new PermissionHook((request) => cli.requestPermission(request)),
    ]);
    const toolRegistry = createToolRegistry(project.workDir, hooks);

    // 4. Harness — wires project, persistence, and agent loop together
    const repo = new SessionRepo(project);
    const sessionStore = await repo.create();
    const harness = new AgentHarness(
      project,
      sessionStore,
      client,
      toolRegistry,
      hooks,
      formatSystemPrompt(CODING_SYSTEM_PROMPT),
    );

    // 5. CLI presentation
    await cli.run(harness);
  } finally {
    cli.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  void asyncMain().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
```

Important: `CliFrontend.run()` currently takes `AgentSession`. Since `AgentHarness` exposes `prompt()` with the same `AsyncIterable<AgentEvent>` semantics, we need to update `CliFrontend.run()` to accept `AgentHarness` instead.

- [ ] **Step 2: Update CliFrontend.run() to accept AgentHarness**

Edit `src/cli/frontend.ts` — change the `run` method signature:

```ts
import type { AgentHarness } from "../agent/harness/agent-harness.js";

// In CliFrontend class:
async run(harness: AgentHarness): Promise<void> {
  console.log("s01: Agent Loop");
  console.log("输入问题，回车发送。输入 q 退出。\n");
  while (true) {
    let query: string;
    try {
      query = await this.readline.question(`${CYAN}s01 >> ${RESET}`);
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

    for await (const event of harness.prompt(query)) {
      renderAgentEvent(
        event,
        (text) => process.stdout.write(text),
        (text) => console.log(text),
      );
    }
    console.log();
  }
}
```

Remove the `AgentSession` import (no longer needed):

```ts
// Remove this line:
- import type { AgentSession } from "../agent/agent-session.js";
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: should succeed now. If errors remain, they are in test files (fixed next).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rewrite main.ts as thin composition root"
```

---

### Task 9: Migrate test files

**Files to move:**
- `tests/agent-turn.test.ts` → `tests/agent/agent-loop.test.ts`
- `tests/agent-session.test.ts` → `tests/agent/agent-session.test.ts`
- `tests/hooks/registry.test.ts` → `tests/agent/hooks/registry.test.ts`
- `tests/hooks/permission.test.ts` → `tests/coding/permission.test.ts`
- `tests/tools/bash.test.ts` → `tests/coding/tools/bash.test.ts`
- `tests/tools/files.test.ts` → `tests/coding/tools/files.test.ts`
- `tests/tools/factory.test.ts` → `tests/coding/tools/factory.test.ts`
- `tests/tools/registry.test.ts` → `tests/agent/tools/registry.test.ts`
- `tests/tools/base.test.ts` → `tests/agent/tools/base.test.ts`

**Files to update (imports only, not moved):**
- `tests/main.test.ts`
- `tests/import-smoke.test.ts`

**Files unchanged:**
- `tests/llm-client/*.test.ts`
- `tests/llm-client/fixtures.ts`
- `tests/utils/timeout.test.ts`

- [ ] **Step 1: Create test directories**

```bash
mkdir -p tests/agent/hooks
mkdir -p tests/agent/tools
mkdir -p tests/coding/tools
```

- [ ] **Step 2: Move agent-loop.test.ts and fix imports**

```bash
git mv tests/agent-turn.test.ts tests/agent/agent-loop.test.ts
```

Edit `tests/agent/agent-loop.test.ts` — update source imports:

```
- import { ..., runAgentTurn } from "../src/agent-turn.js";
+ import { ..., runAgentTurn } from "../../src/agent/agent-loop.js";

- import { ..., Message } from "../src/llm-client/types.js";
+ import { ..., Message } from "../../src/llm-client/types.js";

- import { Tool } from "../src/tools/types.js";
+ import { Tool } from "../../src/agent/tools/types.js";

- import { ToolRegistry } from "../src/tools/registry.js";
+ import { ToolRegistry } from "../../src/agent/tools/registry.js";
```

- [ ] **Step 3: Move agent-session.test.ts and fix imports**

```bash
git mv tests/agent-session.test.ts tests/agent/agent-session.test.ts
```

Edit imports:

```
- import { AgentSession } from "../src/agent-session.js";
+ import { AgentSession } from "../../src/agent/agent-session.js";

- import type { LLMClient, LLMResponse } from "../src/llm-client/types.js";
+ import type { LLMClient, LLMResponse } from "../../src/llm-client/types.js";

- import { ToolRegistry } from "../src/tools/registry.js";
+ import { ToolRegistry } from "../../src/agent/tools/registry.js";
```

- [ ] **Step 4: Move hooks/registry.test.ts and fix imports**

```bash
git mv tests/hooks/registry.test.ts tests/agent/hooks/registry.test.ts
```

Edit imports:

```
- import { ..., Hook } from "../../src/hooks/types.js";
+ import { ..., Hook } from "../../../src/agent/hooks/types.js";

- import { createHookRegistry } from "../../src/hooks/factory.js";
+ import { createHookRegistry } from "../../../src/agent/hooks/factory.js";

- import { HookRegistry } from "../../src/hooks/registry.js";
+ import { HookRegistry } from "../../../src/agent/hooks/registry.js";
```

- [ ] **Step 5: Move permission.test.ts and fix imports**

```bash
git mv tests/hooks/permission.test.ts tests/coding/permission.test.ts
```

Edit imports:

```
- import { PermissionHook, type PermissionRequest } from "../../src/hooks/builtin/permission.js";
+ import { PermissionHook, type PermissionRequest } from "../../src/coding/permission.js";

- import { HookRegistry } from "../../src/hooks/registry.js";
+ import { HookRegistry } from "../../src/agent/hooks/registry.js";
```

- [ ] **Step 6: Move tools/bash.test.ts**

```bash
git mv tests/tools/bash.test.ts tests/coding/tools/bash.test.ts
```

Edit imports:

```
- import { BashTool } from "../../src/tools/builtin/bash.js";
+ import { BashTool } from "../../../src/coding/tools/bash.js";
```

- [ ] **Step 7: Move tools/files.test.ts**

```bash
git mv tests/tools/files.test.ts tests/coding/tools/files.test.ts
```

Edit imports:

```
- import { EditFileTool, ReadFileTool, WriteFileTool } from "../../src/tools/builtin/files.js";
+ import { EditFileTool, ReadFileTool, WriteFileTool } from "../../../src/coding/tools/files.js";

- import { GlobTool } from "../../src/tools/builtin/glob.js";
+ import { GlobTool } from "../../../src/coding/tools/glob.js";
```

- [ ] **Step 8: Move tools/factory.test.ts**

```bash
git mv tests/tools/factory.test.ts tests/coding/tools/factory.test.ts
```

Edit imports:

```
- import { createToolRegistry } from "../../src/tools/factory.js";
+ import { createToolRegistry } from "../../../src/coding/tools/factory.js";
```

- [ ] **Step 9: Move tools/registry.test.ts**

```bash
git mv tests/tools/registry.test.ts tests/agent/tools/registry.test.ts
```

Edit imports:

```
- import { HookRegistry } from "../../src/hooks/registry.js";
+ import { HookRegistry } from "../../../src/agent/hooks/registry.js";

- import type { Hook, HookResult, PreToolUseEvent } from "../../src/hooks/types.js";
+ import type { Hook, HookResult, PreToolUseEvent } from "../../../src/agent/hooks/types.js";

- import { Tool } from "../../src/tools/types.js";
+ import { Tool } from "../../../src/agent/tools/types.js";

- import { ToolRegistry } from "../../src/tools/registry.js";
+ import { ToolRegistry } from "../../../src/agent/tools/registry.js";
```

- [ ] **Step 10: Move tools/base.test.ts**

```bash
git mv tests/tools/base.test.ts tests/agent/tools/base.test.ts
```

Edit imports:

```
- import { Tool } from "../../src/tools/types.js";
+ import { Tool } from "../../../src/agent/tools/types.js";
```

- [ ] **Step 11: Update tests/main.test.ts (not moved, imports only)**

```ts
// Before:
import { renderAgentEvent } from "../src/cli.js";
import type { LLMResponse } from "../src/llm-client/types.js";

// After:
import { renderAgentEvent } from "../src/cli/render.js";
import type { LLMResponse } from "../src/llm-client/types.js";
```

- [ ] **Step 12: Update tests/import-smoke.test.ts (not moved, imports only)**

Read the file first, then update any stale import paths. Likely needs:

```
- from "../src/..." 
+ check each import against new paths
```

- [ ] **Step 13: Clean up empty test directories**

```bash
rmdir tests/hooks 2>/dev/null || true
rmdir tests/tools 2>/dev/null || true
```

- [ ] **Step 14: Run full test suite**

```bash
npm test
```

Expected: all 52 tests pass.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "test: migrate tests to match new directory structure"
```

---

### Task 10: Final verification

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: success, zero errors.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: success, dist/ populated.

- [ ] **Step 3: Full test suite**

```bash
npm test
```

Expected: 52 passed, 0 failed.

- [ ] **Step 4: Import layer audit**

```bash
# Verify agent/ never imports from cli/ or coding/
! grep -r "from.*\.\./cli/" src/agent/ && echo "PASS: agent/ → cli/ clean"
! grep -r "from.*\.\./coding/" src/agent/ && echo "PASS: agent/ → coding/ clean"

# Verify coding/ never imports from cli/
! grep -r "from.*\.\./cli/" src/coding/ && echo "PASS: coding/ → cli/ clean"

# Verify llm-client/ never imports from agent/ or coding/ or cli/
! grep -r "from.*\.\./agent/" src/llm-client/ && echo "PASS: llm-client/ → agent/ clean"
! grep -r "from.*\.\./coding/" src/llm-client/ && echo "PASS: llm-client/ → coding/ clean"
```

Expected: all "PASS" lines, no matches.

- [ ] **Step 5: Whitespace check**

```bash
git diff --check
```

Expected: no trailing whitespace errors.

- [ ] **Step 6: Final commit if needed**

```bash
git status --short
# Should be clean. If not, commit remaining changes.
```
