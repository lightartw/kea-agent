# LLM Client Interface Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `llm-client` following Pi's `ai` package: Tool/AgentTool split, Context type, drop "system" role, prune exports.

**Architecture:** 5 tasks in dependency order. Each task changes one layer. Task 1 is the foundation (llm-client types), Task 2 updates adapters and adapts to the new types, Task 3 renames agent/tools, Task 4 updates agent core + harness, Task 5 fixes tests and verifies. No task can be skipped or reordered.

**Tech Stack:** TypeScript 7.0, Node.js 24, TypeBox 1.3.6, node:test

## Global Constraints

- `cli/` → `agent/` → `llm-client/` → `utils/` dependency direction preserved
- 52 existing tests must pass after all tasks
- `npm run typecheck` must succeed after every task
- `ToolCall` and `Tool` are defined in `llm-client/types.ts` only
- `"system"` role removed from `Message.role` union
- `LLMClient.stream()` accepts `Context` instead of `(messages, tools, options)`

---

### Task 1: Redesign llm-client types

**Files:**
- Modify: `src/llm-client/types.ts`

**Interfaces:**
- Produces: `Tool` (interface, 3 fields), `ToolCall` (+ `type` field), `Context` (new, bundles systemPrompt + messages + tools), `Message` (role minus "system"), plus existing `LLMClient`/`LLMResponse` unchanged

- [ ] **Step 1: Rewrite `src/llm-client/types.ts`**

Replace the entire file:

```ts
import type { TObject } from "typebox";

// ── LLM-facing tool definition (thin, no execute) ──

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}

// ── Wire-format tool call ──

export interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type FinishReason = "stop" | "length" | "tool_calls" | null;

// ── Conversation messages (no system role) ──

export interface Message {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface LLMResponse {
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly finishReason: FinishReason;
}

export type LLMStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "response_done"; readonly response: LLMResponse };

export interface LLMOptions {
  readonly timeout: number;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}

export interface LLMConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly options: LLMOptions;
}

// ── Request context (replaces separate params) ──

export interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

// ── LLM client interface ──

export interface LLMClient {
  invoke(
    context: Context,
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse>;

  stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent>;
}
```

- [ ] **Step 2: Verify typecheck fails on adapters (expected — Task 2 fixes them)**

```bash
npx tsc --noEmit 2>&1 | head -5
```

Expected: errors in adapters about `ToolSchema` not found, `stream()` parameter count mismatch. This is expected — Task 2 fixes adapters.

- [ ] **Step 3: Commit**

```bash
git add src/llm-client/types.ts
git commit -m "refactor: redesign llm-client types — Tool, Context, drop system role"
```

---

### Task 2: Update llm-client adapters and index

**Files:**
- Modify: `src/llm-client/adapters/anthropic.ts`
- Modify: `src/llm-client/adapters/openai.ts`
- Modify: `src/llm-client/adapters/gemini.ts`
- Modify: `src/llm-client/index.ts`
- Modify: `src/llm-client/factory.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolCall`, `Context`, `LLMClient` from `types.ts` (Task 1)
- Produces: adapters compile with new types; index exports 7 names only

- [ ] **Step 1: Update Anthropic adapter**

Read `src/llm-client/adapters/anthropic.ts`. Two edits:

Edit 1 — import line 14:
```
- import type { ToolCall, ToolSchema } from "../types.js";
+ import type { Tool, ToolCall, Context, LLMResponse, LLMStreamEvent, FinishReason } from "../types.js";
```

Edit 2 — `toolsForAnthropic` function (line 58):
```ts
// Before:
function toolsForAnthropic(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
}

// After:
function toolsForAnthropic(tools: readonly Tool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}
```

Edit 3 — tool call parsing (line 73): add `type` field:
```ts
// Before:
if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: block.input });

// After:
if (block.type === "tool_use") toolCalls.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input });
```

Edit 4 — `stream()` and `invoke()` signatures: change `messages` + `tools` params to `context: Context`:
```ts
// Before (line ~98):
async stream(messages: readonly Message[], tools?: readonly ToolSchema[], options?: Partial<LLMOptions>): AsyncIterable<LLMStreamEvent> {

// After:
async stream(context: Context, options?: Partial<LLMOptions>): AsyncIterable<LLMStreamEvent> {
```

Same pattern for `invoke()`. Inside both methods, replace `messages` → `context.messages`, `tools` → `context.tools`.

- [ ] **Step 2: Update OpenAI adapter**

Same 4 edits as Step 1: import `Tool` instead of `ToolSchema`, add `type` to `ToolCall` construction, change `stream()`/`invoke()` to accept `Context`. OpenAI passes tools through as-is so the conversion is simpler — just `context.tools` where `tools` was.

- [ ] **Step 3: Update Gemini adapter**

Same 4 edits. `toolsForGemini` converts `Tool[]` (flat `{name, description, parameters}`) to Gemini's `functionDeclarations` format — adapt from the new flat shape.

- [ ] **Step 4: Update `src/llm-client/factory.ts`**

`createLLMClient` constructs adapters. Check if any adapter constructor call passes tool-related types — no, adapters are constructed without tool types. No change needed.

- [ ] **Step 5: Update `src/llm-client/index.ts`**

Replace `export *` with explicit named exports:

```ts
export type { Context, LLMClient, LLMResponse, Message, Tool, ToolCall } from "./types.js";
export { createLLMClient } from "./factory.js";
```

`LLMStreamEvent`, `FinishReason`, `TokenUsage`, `LLMOptions`, `LLMConfig` are deliberately NOT exported — internal types only.

- [ ] **Step 6: Verify llm-client layer typechecks**

```bash
npx tsc --noEmit 2>&1
```

Expected: errors only in non-llm-client files (agent/, harness/, main.ts, tests). llm-client/ itself must be clean.

- [ ] **Step 7: Commit**

```bash
git add src/llm-client/
git commit -m "refactor: update adapters for Tool/Context, prune llm-client index"
```

---

### Task 3: Rename agent/tools — AgentTool implements Tool

**Files:**
- Modify: `src/agent/tools/types.ts`
- Modify: `src/agent/tools/registry.ts`

**Interfaces:**
- Consumes: `Tool` from `llm-client/types.ts` (Task 1)
- Produces: `AgentTool<T> implements Tool`, `ToolRegistry` updated

- [ ] **Step 1: Rewrite `src/agent/tools/types.ts`**

```ts
import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";

import type { Tool, ToolCall } from "../../llm-client/types.js";

/** The registry's result, returned to both the model and the terminal. */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** Agent-side tool: schema + validation + execution. Implements the llm-client Tool interface. */
export abstract class AgentTool<TParameters extends TObject = TObject> implements Tool {
  private readonly validator: Validator;

  protected constructor(
    readonly name: string,
    readonly description: string,
    readonly parameters: TParameters,
  ) {
    this.validator = Compile(parameters);
  }

  /** Keep TypeBox details with the schema that defines valid arguments. */
  validate(arguments_: unknown): string | undefined {
    if (this.validator.Check(arguments_)) return undefined;
    return this.validator.Errors(arguments_)[0]?.message ?? "validation failed";
  }

  abstract execute(
    arguments_: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<string>;
}

// Re-export for consumers that only import from agent/tools
export type { Tool, ToolCall };
```

Key changes: `Tool<T>` → `AgentTool<T>`, `implements Tool` from llm-client, remove `toSchema()` method, remove `ToolSchema` re-export, re-export `Tool` and `ToolCall` from llm-client for backward compat.

- [ ] **Step 2: Update `src/agent/tools/registry.ts`**

Edit 1 — import line 3:
```ts
// Before:
import { Tool, type ToolCall, type ToolResult, type ToolSchema } from "./types.js";

// After:
import { AgentTool, type ToolCall, type ToolResult } from "./types.js";
import type { Tool } from "../../llm-client/types.js";
```

Edit 2 — `tools` map type (line 9):
```ts
// Before:
private readonly tools = new Map<string, Tool>();

// After:
private readonly tools = new Map<string, AgentTool>();
```

Edit 3 — `register()` parameter (line 18):
```ts
// Before:
register(tool: Tool): void {

// After:
register(tool: AgentTool): void {
```

Edit 4 — `schemas()` method (line 29):
```ts
// Before:
schemas(): ToolSchema[] {
  return [...this.tools.values()].map((tool) => tool.toSchema());
}

// After:
schemas(): Tool[] {
  return [...this.tools.values()]; // AgentTool implements Tool
}
```

`toSchema()` is gone — `AgentTool` itself satisfies the `Tool` interface.

- [ ] **Step 3: Verify agent/tools typechecks (other agent files still broken)**

```bash
npx tsc --noEmit 2>&1 | grep "agent/tools"
```

Expected: no errors in `agent/tools/`. Errors in `agent/agent.ts`, `agent/agent-loop.ts` etc. are expected — Task 4 fixes them.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/
git commit -m "refactor: rename Tool<T> to AgentTool<T> implements Tool"
```

---

### Task 4: Update agent core, hooks, and harness

**Files:**
- Modify: `src/agent/hooks/types.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/harness/system-prompt.ts`
- Modify: `src/harness/hooks/context-inject.ts`
- Modify: `src/harness/session/jsonl-storage.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/harness/messages.ts`
- Modify: `src/harness/session/session.ts`
- Modify: `src/harness/session/session-repo.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolCall`, `Context`, `Message` from llm-client (Task 1), `AgentTool`, `ToolResult` from agent/tools (Task 3)
- Produces: all files typecheck; `Message` without "system" role handled in session persistence

- [ ] **Step 1: Fix `src/agent/hooks/types.ts` imports**

`ToolCall` was imported from `../tools/types.js`. Now needs from llm-client:
```ts
// Before:
import type { Message } from "../../llm-client/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

// After:
import type { Message, ToolCall } from "../../llm-client/types.js";
import type { ToolResult } from "../tools/types.js";
```

- [ ] **Step 2: Fix `src/agent/types.ts` — `AgentEvent.turn_end`**

Check the file imports `LLMResponse` from `../llm-client/types.js` — this is still correct. No change needed (verify).

- [ ] **Step 3: Update `src/agent/agent.ts`**

Edit 1 — add `systemPrompt` as settable property, replace system message push:
```ts
export class Agent {
  private readonly history: Message[];
  private active = false;

  /** Settable system prompt — hooks can append to it via context return. */
  systemPrompt = "";   // ← NEW

  // In prompt(), replace:
  if (result?.context !== undefined) {
    this.history.push({ role: "system", content: result.context });  // ← DELETE
  }
  // With:
  if (result?.context !== undefined) {
    this.systemPrompt += (this.systemPrompt ? "\n" : "") + result.context;  // ← NEW
  }
```

Edit 2 — pass `systemPrompt` to `runAgentTurn`:
```ts
// Before:
yield* runAgentTurn(this.history, this.client, this.registry, this.hooks);

// After:
yield* runAgentTurn(this.history, this.systemPrompt, this.client, this.registry, this.hooks);
```

Constructor signature unchanged — `systemPrompt` is set after construction in `main.ts`.

- [ ] **Step 4: Update `src/agent/agent-loop.ts`**

Rewrite to use `Context`:

```ts
import type {
  LLMClient,
  LLMResponse,
  Message,
  Context,         // ← NEW
} from "../llm-client/types.js";
import type { HookRegistry } from "./hooks/registry.js";
import type { AgentEvent } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";

export async function* runAgentTurn(
  messages: Message[],
  systemPrompt: string,        // ← NEW parameter
  client: LLMClient,
  registry: ToolRegistry,
  hooks?: HookRegistry,
): AsyncIterable<AgentEvent> {
  while (true) {
    // ④ pre_turn
    if (hooks !== undefined) {
      const result = await hooks.trigger({ type: "pre_turn" });
      if (result?.context !== undefined) {
        messages.push({ role: "user", content: result.context });
      }
    }

    // Build Context
    const ctx: Context = {
      systemPrompt: systemPrompt || undefined,
      messages,
      tools: registry.schemas(),
    };

    let response: LLMResponse | undefined;
    for await (const event of client.stream(ctx)) {    // ← was client.stream(messages, registry.schemas())
      if (event.type === "text_delta") {
        yield event;
      } else {
        response = event.response;
      }
    }
    // ... rest unchanged
  }
}
```

Key: `client.stream(ctx)` replaces `client.stream(messages, registry.schemas())`.

- [ ] **Step 5: Update harness session files — drop system message handling**

In `src/harness/session/jsonl-storage.ts` — no code change needed (just read/write JSON). The `Message` type no longer has `"system"` role, so TypeScript will reject old session files that contain it. Add a filter in `readJsonl`:

```ts
// In readJsonl(), after JSON.parse:
const msg = JSON.parse(line) as Message & { role: string };
if (msg.role === "system") continue; // skip legacy system messages
messages.push(msg);
```

- [ ] **Step 6: Update `src/harness/hooks/context-inject.ts`**

Read the file. Its `execute()` returns `{ context: "Working directory: ..." }`. The context field now appends to `systemPrompt` in `Agent.prompt()` (not pushed as system message). No change needed in the hook itself — it still returns `{ context }`, and Agent now handles it by appending to systemPrompt.

- [ ] **Step 7: Update `src/harness/types.ts` and `src/harness/messages.ts`**

`harness/types.ts` imports `Message` from `../llm-client/types.js` — still correct, but `Message` no longer has "system" role. Verify no code uses `role: "system"`.

`harness/messages.ts` imports `Message` — same, verify no system role usage.

- [ ] **Step 8: Verify agent/ + harness/ typecheck together**

```bash
npx tsc --noEmit 2>&1
```

Expected: may still have errors in `main.ts` and tests only.

- [ ] **Step 9: Commit**

```bash
git add src/agent/ src/harness/
git commit -m "refactor: adapt agent and harness to Context, drop system messages"
```

---

### Task 5: Fix main.ts, tests, final verification

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/harness/tools/factory.test.ts`
- Modify: `tests/agent/tools/registry.test.ts`
- Modify: `tests/agent/tools/base.test.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/agent/agent.test.ts`
- Modify: `tests/harness/permission.test.ts`
- Modify: `tests/harness/tools/bash.test.ts`
- Modify: `tests/harness/tools/files.test.ts`
- Modify: `tests/llm-client/anthropic.test.ts`
- Modify: `tests/llm-client/openai.test.ts`
- Modify: `tests/llm-client/gemini.test.ts`
- Modify: `tests/llm-client/client.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/import-smoke.test.ts`

- [ ] **Step 1: Update `src/main.ts`**

Remove system message from initial messages, pass system prompt to Agent:

```ts
// Before:
const messages = history.length === 0
  ? [{ role: "system" as const, content: formatSystemPrompt(CODING_SYSTEM_PROMPT, { cwd: project.workDir, date: new Date() }) }]
  : [...history];
const agent = new Agent(client, toolRegistry, messages, hooks);

// After:
const systemPrompt = history.length === 0
  ? formatSystemPrompt(CODING_SYSTEM_PROMPT, { cwd: project.workDir, date: new Date() })
  : "";
const agent = new Agent(client, toolRegistry, history, hooks);
agent.setSystemPrompt(systemPrompt);  // or pass in constructor
```

Wait — need to add `systemPrompt` support to Agent constructor or a setter. Simpler: pass it in constructor:

```ts
// Agent constructor gains systemPrompt parameter:
constructor(
  private readonly client: LLMClient,
  private readonly registry: ToolRegistry,
  initialMessages: readonly Message[] = [],
  initialSystemPrompt = "",          // ← NEW
  private readonly hooks?: HookRegistry,
) {
  this.history = [...initialMessages];
  this.systemPrompt = initialSystemPrompt;
}

// main.ts:
const systemPrompt = history.length === 0
  ? formatSystemPrompt(CODING_SYSTEM_PROMPT, { cwd: project.workDir, date: new Date() })
  : "";
const agent = new Agent(client, toolRegistry, history, systemPrompt, hooks);
```

- [ ] **Step 2: Fix `src/agent/agent.ts` — add initialSystemPrompt param**

Update constructor:
```ts
constructor(
  private readonly client: LLMClient,
  private readonly registry: ToolRegistry,
  initialMessages: readonly Message[] = [],
  private systemPrompt = "",          // ← NEW (was field, now param)
  private readonly hooks?: HookRegistry,
) {
  this.history = [...initialMessages];
}
```

Remove the `private systemPrompt = ""` field declaration — now it's a constructor param.

- [ ] **Step 3: Fix test files — `AgentTool` rename**

Search and replace across all test files:
- `import { Tool } from "....../agent/tools/types.js"` → `import { AgentTool } from "....../agent/tools/types.js"`
- `new Tool(` → `new AgentTool(`
- `extends Tool` → `extends AgentTool`
- Mock `Tool` classes → `AgentTool`

Use grep to find all occurrences, then fix each.

- [ ] **Step 4: Fix `tests/harness/tools/factory.test.ts`**

Already fixed in previous session (added `"todo_write"`). Verify expected list still correct.

- [ ] **Step 5: Fix llm-client test files — mock client interfaces**

In `tests/llm-client/*.test.ts`, mock `LLMClient` implementations must change `stream(messages, tools?, options?)` → `stream(context, options?)`. Same for `invoke()`.

- [ ] **Step 6: Fix `tests/agent/agent-loop.test.ts`**

`runAgentTurn` now takes 5 params: `(messages, systemPrompt, client, registry, hooks?)`. Update all calls.

- [ ] **Step 7: Fix `tests/agent/agent.test.ts`**

`Agent` constructor now has `initialSystemPrompt` param. Update test instantiations. Also fix any `role: "system"` in test message fixtures → remove or convert to user messages.

- [ ] **Step 8: Fix `tests/harness/permission.test.ts`**

Import paths for `ToolCall` — now from llm-client directly, not re-exported from agent/tools. Check and fix.

- [ ] **Step 9: Run full test suite**

```bash
npm run build && node --test "dist/tests/**/*.test.js"
```

Expected: 52 passed, 0 failed.

- [ ] **Step 10: Import layer audit**

```bash
# agent/ never imports from cli/ or harness/
! grep -r "from.*\.\./cli/" src/agent/ && echo "PASS"
! grep -r "from.*\.\./harness/" src/agent/ && echo "PASS"
# llm-client/ never imports from agent/ or harness/ or cli/
! grep -r "from.*\.\./agent/" src/llm-client/ && echo "PASS"
! grep -r "from.*\.\./harness/" src/llm-client/ && echo "PASS"
# harness/ never imports from cli/
! grep -r "from.*\.\./cli/" src/harness/ && echo "PASS"
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: finalize llm-client redesign — main, tests, verification"
```
