# LLM Client Interface Redesign

**Date:** 2026-07-24  
**Reference:** Pi `ai` package (`D:/programming/projects/pi/packages/ai/src/types.ts`)

## Summary

Redesign `llm-client` following Pi's `ai` package patterns. Five changes:

1. `Tool` becomes the base interface in llm-client; agent renames to `AgentTool implements Tool`
2. `ToolCall` gains a `type: "toolCall"` discriminator
3. New `Context` type bundles `{systemPrompt, messages, tools}` — `stream()` drops from 3 params to 2
4. `Message` drops `"system"` role — system prompt lives in `Context.systemPrompt`
5. Index barreling pruned — 10 exports → 8

Goal: llm-client is a standalone, thin transport layer with no knowledge of agent-level concepts.

---

## Section 1 — `Tool` / `AgentTool` Split

### Before

```text
llm-client/types.ts:  ToolSchema { type, function: { name, description, parameters } }
agent/tools/types.ts: Tool<T> abstract class (name, description, parameters, validate, execute)
                      re-exports ToolSchema from llm-client
```

Two types that describe the same thing but don't relate structurally.

### After

```ts
// llm-client/types.ts
import type { TObject } from "typebox";

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}
```

```ts
// agent/tools/types.ts
import { Tool } from "../../llm-client/types.js";

export abstract class AgentTool<T extends TObject = TObject> implements Tool {
  // name, description, parameters — from constructor, satisfy Tool
  // validate(), execute() — agent-only
}
```

### Changes

| File | Before | After |
|---|---|---|
| `llm-client/types.ts` | `ToolSchema` interface (OpenAI shape) | `Tool` interface (3 fields) |
| `agent/tools/types.ts` | `Tool<T>` + re-export `ToolSchema` | `AgentTool<T> implements Tool` |
| `agent/tools/registry.ts` | `schemas(): ToolSchema[]` | returns `Tool[]` directly |
| `llm-client/adapters/*.ts` | import `ToolSchema` | import `Tool`, convert inline |

### Why — Tool/AgentTool split

- Dependency direction: `agent → llm-client`, `AgentTool` is a natural extension of `Tool`
- No intermediate `ToolSchema` type — adapters own the conversion to provider JSON
- Third parties can use `llm-client` alone with plain `Tool[]`, no agent layer needed

---

## Section 2 — `ToolCall` Discriminator

### Before

```ts
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

### After

```ts
export interface ToolCall {
  readonly type: "toolCall";    // ← new
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

### Why — ToolCall discriminator

- Pi alignment — `ToolCall` has `type: "toolCall"` as content-block discriminator
- Enables future content-block `Message` pattern without migration
- Zero runtime cost

---

## Section 3 — `Context` Type

### Before

```ts
interface LLMClient {
  stream(
    messages: readonly Message[],
    tools?: readonly Tool[],
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent>;
}
```

### After

```ts
export interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

interface LLMClient {
  stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent>;
}
```

### Why — Context type

- 3 params → 2 params
- System prompt no longer disguised as a message
- Adapters receive a complete, self-contained request context
- Pi alignment

---

## Section 4 — `Message` Drops System Role

### Before

```ts
export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  // ...
}
```

### After

```ts
export interface Message {
  readonly role: "user" | "assistant" | "tool";
  // ...
}
```

### Migration

- `user_prompt_submit` hook's `context` return currently pushes a system message — change to append to `systemPrompt` or push a user message
- Old JSONL sessions with `role: "system"` records: `SessionStore.load()` skips or converts them on read

### Why — drop system role

- System prompt is request configuration, not conversation history
- Fewer branches: no `if (msg.role === "system")` checks
- Pi alignment

---

## Section 5 — Index Pruning

### Exported (7 names)

| Name | Consumer |
|---|---|
| `Tool` | `agent/tools` (AgentTool extends) |
| `ToolCall` | `Message`, `LLMResponse` |
| `Message` | agent, harness, session |
| `Context` | agent-loop |
| `LLMClient` | agent |
| `LLMResponse` | agent-loop, agent/types |
| `createLLMClient` | main.ts |

### Internal (unexported, 6 names)

| Name | Why internal |
|---|---|
| `FinishReason` | consumed via `LLMResponse.finishReason` |
| `TokenUsage` | consumed via `LLMResponse.usage` |
| `LLMOptions` | external code uses `Partial<LLMOptions>` only |
| `LLMConfig` | factory-private |
| `LLMStreamEvent` | type-inferred via `for await` over stream return type |
| `mergeOptions` | adapter-internal utility |

---

## Full External Interface (After)

```ts
// llm-client/index.ts
export type { Tool } from "./types.js";
export type { ToolCall } from "./types.js";
export type { Message } from "./types.js";
export type { Context } from "./types.js";
export type { LLMClient } from "./types.js";
export type { LLMResponse } from "./types.js";
export { createLLMClient } from "./factory.js";
```

## File Impact Summary

| File | Change |
|---|---|
| `llm-client/types.ts` | Replace `ToolSchema` with `Tool`; add `Context`; add `type` to `ToolCall`; remove `"system"` from `Message.role`; mark 5 internal types unexported |
| `llm-client/index.ts` | Named exports only (7 names) |
| `llm-client/adapters/*.ts` | `ToolSchema` → `Tool`, adapt conversion |
| `llm-client/factory.ts` | `Context` in stream calls |
| `agent/tools/types.ts` | `Tool<T>` → `AgentTool<T> implements Tool`; remove `ToolSchema` re-export |
| `agent/tools/registry.ts` | `schemas()` return type; `ToolCall` import path stays same |
| `agent/agent-loop.ts` | Build `Context` before `client.stream()` |
| `agent/agent.ts` | Extract system prompt from messages |
| `agent/hooks/types.ts` | `context` result: system message → system prompt append or user message |
| `agent/types.ts` | `AgentEvent.turn_end` — no change to `LLMResponse` import |
| `harness/session/*.ts` | `Message.role` type narrows (no `"system"`) — skip system messages on load |
| `harness/system-prompt.ts` | `formatSystemPrompt` result goes to `Context.systemPrompt`, not as a message |
| `harness/hooks/context-inject.ts` | `context` result appends to system prompt |
| `harness/agent-harness.ts` | No system message in initial messages; pass system prompt separately |
| `main.ts` | System prompt passes to `Context`, not into messages |
| Tests | `AgentTool` rename; factory test name list; mock clients accept `Context` |

## Non-goals

- Content-block `Message` pattern (Pi's `(TextContent | ThinkingContent | ToolCall)[]`) — deferred
- `AgentLoopConfig` callback pattern (Pi's `beforeToolCall`/`afterToolCall` callbacks) — Kea keeps `HookRegistry`
- `AgentMessage = Message | CustomMessages` extensibility — deferred
