# LLM Client Streaming v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `llm-client` streaming protocol following Pi's content-block model. Replace `LLMResponse` with `AssistantMessage`, split `Message` into 3 discriminated types, add 7 `AssistantMessageEvent` variants.

**Architecture:** 6 tasks in dependency order. Task 1 is foundation (types), Task 2 implements adapters, Task 3 updates agent core, Task 4 updates harness + CLI, Task 5 fixes main.ts + tests, Task 6 verifies.

**Tech Stack:** TypeScript 7.0, Node.js 24, TypeBox 1.3.6, node:test

## Global Constraints

- 52 tests must pass after all tasks
- `npm run typecheck` must succeed after every task (within the layer being built)
- `LLMResponse` type deleted — replaced by `AssistantMessage`
- `FinishReason` → `StopReason` (adds `"error"`, `"aborted"`)
- `Message` split into `UserMessage | AssistantMessage | ToolResultMessage`
- `LLMClient.invoke()` deleted — only `stream()` remains
- `AssistantMessage.content` is `ContentBlock[]`, not `string | null`

---

### Task 1: Rewrite llm-client types

**Files:**
- Modify: `src/llm-client/types.ts`

**Interfaces:**
- Produces: `ContentBlock`, `TextBlock`, `ThinkingBlock`, `StopReason`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `Message`, `AssistantMessageEvent`, updated `LLMClient`, `Context`, `Tool`, `ToolCall`, `TokenUsage`, `LLMOptions`, `LLMConfig`

- [ ] **Step 1: Replace `src/llm-client/types.ts`**

Replace entire file contents:

```ts
import type { TObject } from "typebox";

// ── Tool types ──

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}

export interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

// ── Content blocks (ordered within an assistant message) ──

export type ContentBlock = TextBlock | ThinkingBlock | ToolCall;

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature?: string;
}

// ── Stop reason ──

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// ── Messages (discriminated union) ──

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
  readonly model: string;
  readonly usage?: TokenUsage;
  readonly stopReason: StopReason;
  readonly errorMessage?: string;
  readonly latencyMs: number;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ── Token usage ──

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

// ── Streaming events ──

export type AssistantMessageEvent =
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: ToolCall }
  | { readonly type: "done";            readonly message: AssistantMessage }
  | { readonly type: "error";           readonly message: AssistantMessage };

// ── Options ──

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

// ── Context ──

export interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

// ── LLM Client (stream only — no invoke) ──

export interface LLMClient {
  stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<AssistantMessageEvent>;
}
```

- [ ] **Step 2: Verify typecheck — expects errors outside llm-client/**

```bash
npx tsc --noEmit 2>&1 | head -5
```

Expected: errors in adapters (no `invoke`, old types), agent/, harness/, tests. llm-client/types.ts itself clean.

- [ ] **Step 3: Commit**

```bash
git add src/llm-client/types.ts
git commit -m "refactor: v2 types — ContentBlock, discriminated Message, AssistantMessageEvent"
```

---

### Task 2: Rewrite llm-client adapters + index + factory

**Files:**
- Modify: `src/llm-client/adapters/anthropic.ts`
- Modify: `src/llm-client/adapters/openai.ts`
- Modify: `src/llm-client/adapters/gemini.ts`
- Modify: `src/llm-client/index.ts`
- Modify: `src/llm-client/factory.ts`

**Interfaces:**
- Consumes: v2 types from Task 1
- Produces: all 3 adapters yield `AssistantMessageEvent`; `invoke()` deleted; index exports updated

- [ ] **Step 1: Rewrite Anthropic adapter**

Delete `invoke()`. Rewrite `stream()` to yield 7 event types:
- `content_block_start` (thinking) → yield `thinking_delta` with empty string first? No — Anthropic gives deltas directly. Only `content_block_delta` for thinking blocks → yield `thinking_delta`
- `content_block_delta` (text) → yield `text_delta`
- `content_block_start` (tool_use) → yield `toolcall_start { id, name }` from the block
- `content_block_delta` (tool_use, input_json_delta) → yield `toolcall_delta { id, argumentsDelta }`
- `content_block_stop` (tool_use) → parse accumulated args JSON → yield `toolcall_end { toolCall }`
- `message_stop` (success) → construct `AssistantMessage` with `ContentBlock[]`, usage, model → yield `done`
- SDK error → construct error `AssistantMessage` → yield `error`

**thinking signature:** extract from `content_block_stop` thinking block, store in `ThinkingBlock.signature`.

- [ ] **Step 2: Rewrite OpenAI adapter**

Delete `invoke()`. Rewrite `stream()`:
- `delta.reasoning_content` → yield `thinking_delta`
- `delta.content` → yield `text_delta`
- First `delta.tool_calls[i]` with id → yield `toolcall_start`
- Subsequent `delta.tool_calls[i].function.arguments` → yield `toolcall_delta`
- All tool call args accumulated → yield `toolcall_end` on each tool's completion (or at finish_reason)
- `finish_reason` + usage → construct `AssistantMessage` → yield `done`
- SDK error → yield `error`

- [ ] **Step 3: Rewrite Gemini adapter**

Delete `invoke()`. Rewrite `stream()`:
Map Gemini's streaming chunks to the 7 events — similar pattern. Gemini may not have separate thinking events.

- [ ] **Step 4: Update `src/llm-client/factory.ts`**

Return type `LLMClient` unchanged — still implements the interface (now stream-only).

- [ ] **Step 5: Update `src/llm-client/index.ts`**

```ts
export type {
  AssistantMessage,
  AssistantMessageEvent,
  ContentBlock,
  Context,
  LLMClient,
  Message,
  StopReason,
  ThinkingBlock,
  TextBlock,
  Tool,
  ToolCall,
  TokenUsage,
  ToolResultMessage,
  UserMessage,
} from "./types.js";
export { createLLMClient } from "./factory.js";
```

- [ ] **Step 6: Verify llm-client typechecks clean**

```bash
npx tsc --noEmit 2>&1 | grep "src/llm-client"
```

Expected: zero errors in llm-client/.

- [ ] **Step 7: Commit**

```bash
git add src/llm-client/
git commit -m "refactor: v2 adapters — stream-only, 7 event types, delete invoke"
```

---

### Task 3: Update agent core

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/hooks/types.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/agent/agent.ts`
- Modify: `src/agent/tools/types.ts`
- Modify: `src/agent/tools/registry.ts`

**Key changes:**

- [ ] **Step 1: `src/agent/types.ts`** — `AgentEvent` gains 4 new variants, `turn_end` uses `AssistantMessage`:

```ts
import type { AssistantMessage } from "../llm-client/types.js";
import type { ToolCall, ToolResult } from "./tools/types.js";

export type AgentEvent =
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: ToolCall }
  | { readonly type: "tool_start";      readonly call: ToolCall }
  | { readonly type: "tool_end";        readonly call: ToolCall; readonly result: ToolResult }
  | { readonly type: "turn_end";        readonly message: AssistantMessage };
```

- [ ] **Step 2: `src/agent/hooks/types.ts`** — `Message` import updated; `StopEvent.messages` type changed; `ToolCall` imported from llm-client.

- [ ] **Step 3: `src/agent/agent-loop.ts`** — Major rewrite:

```ts
// Stream consumption loop:
while (true) {
  // pre_turn hook (unchanged)

  // Accumulation during stream
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinkingSignatures: (string | undefined)[] = [];

  const ctx: Context = { ... };
  for await (const event of client.stream(ctx)) {
    switch (event.type) {
      case "text_delta":
        textParts.push(event.text);
        yield { type: "text_delta", text: event.text };
        break;
      case "thinking_delta":
        thinkingParts.push(event.thinking);
        yield { type: "thinking_delta", thinking: event.thinking };
        break;
      case "toolcall_start":
        yield { type: "toolcall_start", id: event.id, name: event.name };
        break;
      case "toolcall_delta":
        yield { type: "toolcall_delta", id: event.id, argumentsDelta: event.argumentsDelta };
        break;
      case "toolcall_end":
        toolCalls.push(event.toolCall);
        yield { type: "toolcall_end", toolCall: event.toolCall };
        break;
      case "done": {
        const message = event.message;
        messages.push(message);  // AssistantMessage goes directly into history
        if (toolCalls.length === 0) {
          // stop hook
          yield { type: "turn_end", message };
          return;
        }
        break; // fall through to tool execution
      }
      case "error": {
        messages.push(event.message);
        yield { type: "turn_end", message: event.message };
        return;
      }
    }
  }

  // Execute tools (unchanged from current)
  for (const call of toolCalls) {
    // ...
  }
}
```

Key: `AssistantMessage` from `done` pushes directly into `messages[]` — zero conversion.

- [ ] **Step 4: `src/agent/agent.ts`** — Minor: `initialMessages` type is `Message[]` (discriminated union). `history.push` takes `Message`. `systemPrompt` unchanged.

- [ ] **Step 5: `src/agent/tools/types.ts`** — `ToolCall` import from llm-client (already correct). Verify.

- [ ] **Step 6: `src/agent/tools/registry.ts`** — No changes needed (consumes `ToolCall` from local `./types.js`).

- [ ] **Step 7: Verify agent/ typechecks**

```bash
npx tsc --noEmit 2>&1 | grep "src/agent"
```

Expected: zero errors in agent/.

- [ ] **Step 8: Commit**

```bash
git add src/agent/
git commit -m "refactor: agent v2 — AgentEvent +4 variants, direct AssistantMessage push"
```

---

### Task 4: Update harness + CLI

**Files:**
- Modify: `src/harness/types.ts`
- Modify: `src/harness/messages.ts`
- Modify: `src/harness/session/jsonl-storage.ts`
- Modify: `src/harness/session/session.ts`
- Modify: `src/harness/session/session-repo.ts`
- Modify: `src/harness/agent-harness.ts`
- Modify: `src/harness/system-prompt.ts`
- Modify: `src/harness/hooks/context-inject.ts`
- Modify: `src/cli/render.ts`
- Modify: `src/cli/frontend.ts`

- [ ] **Step 1: Harness types** — `SessionStore` uses `Message` (discriminated union now). No change needed to interface signature.

- [ ] **Step 2: Session persistence** — `jsonl-storage.ts`: `readJsonl` returns `Message[]`. `UserMessage`/`AssistantMessage`/`ToolResultMessage` serialize/deserialize by `role` discriminator. Asserts on parse.

- [ ] **Step 3: `src/harness/agent-harness.ts`** — No change (just type reference update).

- [ ] **Step 4: `src/cli/render.ts`** — Rewrite `renderAgentEvent`:

```ts
export function renderAgentEvent(
  event: AgentEvent,
  write: (text: string) => void,
  log: (text: string) => void,
): void {
  switch (event.type) {
    case "text_delta":
      write(event.text); break;
    case "thinking_delta":
      write(`\x1b[90m${event.thinking}\x1b[0m`); break;  // grey
    case "toolcall_start":
      log(`\n\x1b[33m[tool] ${event.name}\x1b[0m`); break;  // yellow
    case "toolcall_delta":
      write(event.argumentsDelta); break;
    case "toolcall_end":
      // tool call complete — already displayed via deltas
      break;
    case "tool_start":
      log(`\n\x1b[33m[exec] ${event.call.name}: ${JSON.stringify(event.call.arguments)}\x1b[0m`); break;
    case "tool_end":
      // result preview
      break;
    case "turn_end":
      // finish
      break;
  }
}
```

- [ ] **Step 5: Verify harness/ + cli/ typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -E "src/(harness|cli)"
```

- [ ] **Step 6: Commit**

```bash
git add src/harness/ src/cli/
git commit -m "refactor: harness + CLI v2 — ContentBlock render, discriminated Message persist"
```

---

### Task 5: Fix main.ts + all tests

**Files:**
- Modify: `src/main.ts`
- Modify: All test files under `tests/`

- [ ] **Step 1: `src/main.ts`** — Update import types. System prompt + agent creation unchanged.

- [ ] **Step 2: Fix all test files**

Mechanical changes:
- Message construction: `{role: "user", content: "hello"}` (was `{role: "user", content: "hello"}` — same for user). For assistant with tool calls, use `ContentBlock[]`.
- Mock LLMClient: implement `stream()` only (no `invoke`). Yield `done` event with `AssistantMessage` or `error` event.
- `AgentEvent` assertions: `turn_end` now has `message` not `response`.
- `runAgentTurn` test calls unchanged (signature stays).
- LLM adapter tests: update expected event types.

- [ ] **Step 3: Run full test suite**

```bash
npm run build && node --test "dist/tests/**/*.test.js"
```

Expected: 52 passed, 0 failed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: v2 final — main.ts, tests, all 52 passing"
```

---

### Task 6: Final verification

- [ ] **Step 1: Build + typecheck**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 2: Full test suite**

```bash
node --test "dist/tests/**/*.test.js"
```

Expected: 52 passed, 0 failed.

- [ ] **Step 3: Import layer audit**

```bash
! grep -r "from.*\.\./cli/" src/agent/ && echo "PASS"
! grep -r "from.*\.\./harness/" src/agent/ && echo "PASS"
! grep -r "from.*\.\./agent/" src/llm-client/ && echo "PASS"
! grep -r "from.*\.\./cli/" src/harness/ && echo "PASS"
```

- [ ] **Step 4: Commit any remaining changes**
