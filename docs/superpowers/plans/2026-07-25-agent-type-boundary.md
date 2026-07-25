# Agent Type Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agent 包引入 `AgentMessage`、`AgentToolCall`、`AgentContext` 领域类型，建立 `convertToLlm` 边界，收束 `runAgentLoop` 的 8 参数为 5 参数。

**Architecture:** 4 个顺序任务，每个任务完成后可独立通过 typecheck。任务间无文件冲突——每个文件只在一个任务中被修改。

**Tech Stack:** TypeScript, Node.js `node:test` + `node:assert/strict`, TypeBox

## Global Constraints

- 不改变任何运行时行为（纯类型重命名 + 参数收束）
- 所有现有测试断言不变
- `AgentMessage = Message`（type alias，非 declaration merging）
- `AgentToolCall` 独立定义结构，不从 ai 类型推导
- 不引入并发工具执行
- 不改 `AgentToolResult` 结构
- 不改 `ModelConfig`
- 不改 Session 持久化层

---

### Task 1: `tools/` — 新增 `AgentToolCall` + 重命名 `AgentToolRegistry`

**Files:**
- Modify: `src/agent/tools/types.ts` — 新增 `AgentToolCall`
- Modify: `src/agent/tools/registry.ts` — 类名 + execute 签名
- Modify: `src/agent/agent-loop.ts` — ToolRegistry import 改为 AgentToolRegistry
- Modify: `src/agent/agent.ts` — ToolRegistry import 改为 AgentToolRegistry
- Modify: `src/harness/agent-harness.ts` — ToolRegistry import 改为 AgentToolRegistry
- Modify: `src/harness/tools/factory.ts` — ToolRegistry import 改为 AgentToolRegistry
- Modify: `tests/agent/agent-loop.test.ts` — ToolRegistry import 改为 AgentToolRegistry
- Modify: `tests/agent/agent.test.ts` — ToolRegistry import 改为 AgentToolRegistry
- Modify: `tests/agent/tools/registry.test.ts` — ToolRegistry import 改为 AgentToolRegistry

**Interfaces:**
- Produces: `AgentToolCall` interface in `src/agent/tools/types`
- Produces: `AgentToolRegistry` class in `src/agent/tools/registry` (was `ToolRegistry`)
- Produces: `execute(call: AgentToolCall)` signature

- [ ] **Step 1: Add `AgentToolCall` to `src/agent/tools/types.ts`**

After the existing `AgentToolResult` interface, add:

```typescript
/** A tool call requested by the model. Agent-side equivalent of ai.ToolCall. */
export interface AgentToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

- [ ] **Step 2: Rename class and update `execute()` signature in `src/agent/tools/registry.ts`**

Change the import to include `AgentToolCall`:

```typescript
// Old:
import type { Tool, ToolCall } from "../../ai/types.js";
// New:
import type { Tool } from "../../ai/types.js";
import type { AgentToolCall } from "./types.js";
```

Rename class:

```typescript
// Old:
export class ToolRegistry {
// New:
export class AgentToolRegistry {
```

Update `execute()` signature:

```typescript
// Old:
async execute(call: ToolCall): Promise<AgentToolResult> {
// New:
async execute(call: AgentToolCall): Promise<AgentToolResult> {
```

- [ ] **Step 3: Update all `ToolRegistry` references across the codebase**

In every file listed below, replace `ToolRegistry` with `AgentToolRegistry`:

**`src/agent/agent-loop.ts`** (line 10):
```typescript
// Old:
import type { ToolRegistry } from "./tools/registry.js";
// New:
import type { AgentToolRegistry } from "./tools/registry.js";
```

And line 23:
```typescript
// Old:
registry: ToolRegistry,
// New:
registry: AgentToolRegistry,
```

**`src/agent/agent.ts`** (line 4):
```typescript
// Old:
import type { ToolRegistry } from "./tools/registry.js";
// New:
import type { AgentToolRegistry } from "./tools/registry.js";
```

And line 27:
```typescript
// Old:
private readonly registry: ToolRegistry,
// New:
private readonly registry: AgentToolRegistry,
```

**`src/harness/agent-harness.ts`** (line 4):
```typescript
// Old:
import { ToolRegistry } from "../agent/tools/registry.js";
// New:
import { AgentToolRegistry } from "../agent/tools/registry.js";
```

And line 20:
```typescript
// Old:
readonly toolRegistry: ToolRegistry;
// New:
readonly toolRegistry: AgentToolRegistry;
```

And line 57:
```typescript
// Old:
private readonly _toolRegistry: ToolRegistry;
// New:
private readonly _toolRegistry: AgentToolRegistry;
```

**`src/harness/tools/factory.ts`** (line 1, 8, 9):
```typescript
// Old:
import { ToolRegistry } from "../../agent/tools/registry.js";
// ...
export function createToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry();
// New:
import { AgentToolRegistry } from "../../agent/tools/registry.js";
// ...
export function createToolRegistry(cwd = process.cwd()): AgentToolRegistry {
  const registry = new AgentToolRegistry();
```

**`tests/agent/agent-loop.test.ts`** (line 19):
```typescript
// Old:
import { ToolRegistry } from "../../src/agent/tools/registry.js";
// New:
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
```

Replace all `new ToolRegistry()` with `new AgentToolRegistry()` in this file (lines 75, 100, 160, 203, 221, 250).

**`tests/agent/agent.test.ts`** (line 6):
```typescript
// Old:
import { ToolRegistry } from "../../src/agent/tools/registry.js";
// New:
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
```

And line 25:
```typescript
// Old:
const agent = new Agent(streamFn, testModel, new ToolRegistry(), [], "system prompt");
// New:
const agent = new Agent(streamFn, testModel, new AgentToolRegistry(), [], "system prompt");
```

**`tests/agent/tools/registry.test.ts`** (line 7):
```typescript
// Old:
import { ToolRegistry } from "../../../src/agent/tools/registry.js";
// New:
import { AgentToolRegistry } from "../../../src/agent/tools/registry.js";
```

Replace all `new ToolRegistry()` with `new AgentToolRegistry()` in this file (lines 22, 30, 48).

- [ ] **Step 4: Verify typecheck and tests pass**

```bash
npm run typecheck
```

Expected: passes with no errors.

```bash
npm test
```

Expected: all tests pass. No assertion changes — pure rename.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: add AgentToolCall, rename ToolRegistry to AgentToolRegistry"
```

---

### Task 2: `agent/` kernel — 新类型 + 新签名 + convertToLlm 边界

**Files:**
- Modify: `src/agent/types.ts` — AgentMessage, AgentContext, updated AgentLoopConfig/AgentEvent/AgentState
- Modify: `src/agent/agent-loop.ts` — 新签名, convertToLlm 边界, 消息操作改用 context
- Modify: `src/agent/agent.ts` — defaultConvertToLlm, prompt() 适配, AgentMessage 类型

**Interfaces:**
- Consumes: `AgentToolCall` + `AgentToolResult` from `./tools/types.js`, `AgentToolRegistry` from `./tools/registry.js`
- Produces: `AgentMessage`, `AgentContext`, updated `AgentLoopConfig`, updated `AgentEvent`, updated `AgentState`
- Produces: `runAgentLoop(input, context, config, streamFn, signal?)` new signature
- Produces: `Agent.defaultConvertToLlm()`

- [ ] **Step 1: Rewrite `src/agent/types.ts`**

```typescript
import type { Message, ModelConfig } from "../ai/types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";

/**
 * Agent-layer message type. Currently an alias for Message; will become
 * an extensible union when custom message types are needed.
 */
export type AgentMessage = Message;

/**
 * Snapshot of agent state passed into the loop.
 * The loop mutates context.messages in place.
 */
export interface AgentContext {
  readonly systemPrompt: string;
  messages: AgentMessage[];
  readonly tools: AgentToolRegistry;
}

/**
 * Callbacks and configuration consumed by the agent loop.
 * model, convertToLlm, and hooks are all in one place.
 */
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];

  /** Before pushing the user message. Return { block } to reject. */
  readonly onUserPrompt?: (prompt: string) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** Before each LLM stream. Return { context } to inject as a user message. */
  readonly onPreTurn?: () => Promise<{ context: string } | undefined>;
  /** Before executing a tool. Return { block } to skip with an error. */
  readonly onBeforeTool?: (call: AgentToolCall) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** After executing a tool. Side-effect only. */
  readonly onAfterTool?: (call: AgentToolCall, result: AgentToolResult) => Promise<void>;
  /** After an assistant message with no tool calls. */
  readonly onStop?: (messages: readonly AgentMessage[]) => Promise<{
    messages?: readonly AgentMessage[];
    forceContinue?: string;
  } | undefined>;
}

/**
 * Presentation-neutral events emitted during one agent run.
 * CLI and future TUI render these independently.
 * All message/tool-call types are agent-layer, not ai-layer.
 */
export type AgentEvent =
  // Run lifecycle
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end";   readonly messages: readonly AgentMessage[] }
  // Turn lifecycle
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end";    readonly message: AgentMessage }
  // Streaming content
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: AgentToolCall }
  // Tool execution
  | { readonly type: "tool_start";      readonly call: AgentToolCall }
  | { readonly type: "tool_end";        readonly call: AgentToolCall; readonly result: AgentToolResult };

/** Public read-only snapshot of the Agent's current state. */
export interface AgentState {
  readonly messages: readonly AgentMessage[];
  readonly model: ModelConfig;
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
```

- [ ] **Step 2: Rewrite `src/agent/agent-loop.ts`**

Replace the entire file content:

```typescript
import type {
  AssistantMessageEvent,
  Context,
  Message,
  ModelConfig,
  StreamFn,
} from "../ai/types.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

// ── Helpers (extracted from old loop body) ──

function aiEventToToolCalls(event: AssistantMessageEvent, toolCalls: AgentToolCall[]): void {
  if (event.type === "toolcall_end") {
    toolCalls.push({
      type: "toolCall",
      id: event.toolCall.id,
      name: event.toolCall.name,
      arguments: event.toolCall.arguments,
    });
  }
}

/**
 * Pure function: run the agent loop from a user input.
 * Mutates `context.messages` in place.
 */
export async function* runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  yield { type: "agent_start" };

  // ── onUserPrompt ──
  if (config.onUserPrompt) {
    try {
      const result = await config.onUserPrompt(input);
      if (result?.block) {
        yield { type: "agent_end", messages: [...context.messages] };
        return;
      }
    } catch {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }
  }

  context.messages.push({ role: "user", content: input } as AgentMessage);

  // ── Main loop ──
  while (true) {
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    yield { type: "turn_start" };

    // ── onPreTurn ──
    if (config.onPreTurn && !signal?.aborted) {
      try {
        const result = await config.onPreTurn();
        if (result?.context !== undefined) {
          context.messages.push({ role: "user", content: result.context } as AgentMessage);
        }
      } catch { /* advisory */ }
    }

    // ── convertToLlm boundary ──
    const llmMessages: Message[] = config.convertToLlm(context.messages);
    const llmContext: Context = {
      ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
      messages: llmMessages,
      tools: context.tools.schemas(),
    };

    const toolCalls: AgentToolCall[] = [];
    let turnMessage: AgentMessage | undefined;

    for await (const event of streamFn(config.model, llmContext, signal === undefined ? {} : { signal })) {
      aiEventToToolCalls(event, toolCalls);

      switch (event.type) {
        case "text_delta":
          yield { type: "text_delta", text: event.text };
          break;
        case "thinking_delta":
          yield { type: "thinking_delta", thinking: event.thinking };
          break;
        case "toolcall_start":
          yield { type: "toolcall_start", id: event.id, name: event.name };
          break;
        case "toolcall_delta":
          yield { type: "toolcall_delta", id: event.id, argumentsDelta: event.argumentsDelta };
          break;
        case "toolcall_end":
          yield {
            type: "toolcall_end",
            toolCall: {
              type: "toolCall",
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
            },
          };
          break;
        case "done":
          context.messages.push(event.message as AgentMessage);
          turnMessage = event.message as AgentMessage;
          break;
        case "error":
          context.messages.push(event.message as AgentMessage);
          yield { type: "turn_end", message: event.message as AgentMessage };
          yield { type: "agent_end", messages: [...context.messages] };
          return;
      }
    }

    yield { type: "turn_end", message: turnMessage! };

    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    // ── No tool calls → onStop ──
    if (toolCalls.length === 0) {
      if (config.onStop && !signal?.aborted) {
        try {
          const result = await config.onStop([...context.messages]);
          if (result?.messages !== undefined) {
            context.messages.length = 0;
            context.messages.push(...result.messages);
          }
          if (result?.forceContinue !== undefined) {
            context.messages.push({ role: "user", content: result.forceContinue } as AgentMessage);
            continue;
          }
        } catch { /* advisory */ }
      }
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    // ── Execute tools ──
    for (const call of toolCalls) {
      yield { type: "tool_start", call };

      let blockReason: string | undefined;
      if (config.onBeforeTool && !signal?.aborted) {
        try {
          const r = await config.onBeforeTool(call);
          if (r?.block) blockReason = r.reason ?? "blocked";
        } catch (error) {
          blockReason = error instanceof Error ? error.message : String(error);
        }
      }

      let result: AgentToolResult;
      if (blockReason !== undefined) {
        result = { content: `Error: ${blockReason}`, isError: true };
      } else if (signal?.aborted) {
        result = { content: "Error: aborted", isError: true };
      } else {
        result = await context.tools.execute(call);
      }

      context.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      } as AgentMessage);
      yield { type: "tool_end", call, result };

      if (config.onAfterTool) {
        try { await config.onAfterTool(call, result); } catch { /* side-effect */ }
      }

      if (signal?.aborted) break;
    }
  }
}
```

- [ ] **Step 3: Rewrite `src/agent/agent.ts`**

Replace the file content:

```typescript
import { runAgentLoop } from "./agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentState } from "./types.js";
import type { Message, ModelConfig, StreamFn } from "../ai/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

/**
 * Stateful wrapper around the pure agent loop. Owns the conversation history,
 * system prompt, model config, and stream function. Harness mutates model and
 * systemPrompt across turns; Agent stays the same instance for the session.
 */
export class Agent {
  private history: AgentMessage[];
  private activeRun: ActiveRun | undefined;
  private errorMessage: string | undefined;
  private _streamFn: StreamFn;
  private _model: ModelConfig;
  private _systemPrompt: string;
  private _hooks: Omit<AgentLoopConfig, "model" | "convertToLlm"> | undefined;

  constructor(
    streamFn: StreamFn,
    model: ModelConfig,
    private readonly _registry: AgentToolRegistry,
    initialMessages: readonly AgentMessage[] = [],
    systemPrompt = "",
    hooks?: Omit<AgentLoopConfig, "model" | "convertToLlm">,
  ) {
    this.history = [...initialMessages];
    this._streamFn = streamFn;
    this._model = model;
    this._systemPrompt = systemPrompt;
    this._hooks = hooks;
  }

  /** Default conversion: AgentMessage = Message, so identity is safe. */
  private static defaultConvertToLlm(messages: AgentMessage[]): Message[] {
    return messages as Message[];
  }

  // ── Public state ──

  get state(): AgentState {
    return {
      messages: this.history,
      model: this._model,
      systemPrompt: this._systemPrompt,
      isRunning: this.activeRun !== undefined,
      ...(this.errorMessage === undefined ? {} : { errorMessage: this.errorMessage }),
    };
  }

  get messages(): readonly AgentMessage[] {
    return this.history;
  }

  get isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  // ── Mutable config (Harness mutates these across turns) ──

  get streamFn(): StreamFn { return this._streamFn; }
  set streamFn(f: StreamFn) { this._streamFn = f; }

  get model(): ModelConfig { return this._model; }
  set model(m: ModelConfig) { this._model = m; }

  get systemPrompt(): string { return this._systemPrompt; }
  set systemPrompt(s: string) { this._systemPrompt = s; }

  // ── Control ──

  /** Cancel the current prompt (if any). The stream stops at the next yield. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /** Cancel current run and clear conversation history. */
  reset(): void {
    this.abort();
    this.history = [];
    this.errorMessage = undefined;
  }

  // ── Prompt ──

  /**
   * Append one user message and run the agent loop until no more tool calls
   * are requested or a hook forces a stop.
   */
  async *prompt(input: string): AsyncIterable<AgentEvent> {
    if (this.activeRun) throw new Error("Agent is already running");

    const abortController = new AbortController();
    this.activeRun = { abortController };
    this.errorMessage = undefined;

    // Build config per-run so model changes are reflected
    const config: AgentLoopConfig = {
      model: this._model,
      convertToLlm: Agent.defaultConvertToLlm,
      ...this._hooks,
    };

    try {
      for await (const event of runAgentLoop(
        input,
        {
          systemPrompt: this._systemPrompt,
          messages: this.history,
          tools: this._registry,
        },
        config,
        this._streamFn,
        abortController.signal,
      )) {
        if (event.type === "agent_end") {
          for (const msg of event.messages) {
            if (msg.role === "assistant" && msg.errorMessage) {
              this.errorMessage = msg.errorMessage;
            } else if (msg.role === "tool" && msg.isError) {
              this.errorMessage = msg.content;
            }
          }
        }
        yield event;
      }
    } finally {
      this.activeRun = undefined;
    }
  }
}
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: passes. If errors, fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: AgentMessage + AgentContext + AgentLoopConfig, convertToLlm boundary, 5-param runAgentLoop"
```

---

### Task 3: Harness adaptation — hooks + agent-harness 类型迁移

**Files:**
- Modify: `src/harness/hooks/types.ts` — ToolCall → AgentToolCall, Message → AgentMessage
- Modify: `src/harness/agent-harness.ts` — AgentLoopConfig 构造适配, 类型引用

**Interfaces:**
- Consumes: `AgentToolCall` from `../../agent/tools/types.js`, `AgentMessage` from `../../agent/types.js`
- Produces: Updated hook event types using agent-layer types

- [ ] **Step 1: Update `src/harness/hooks/types.ts`**

Replace the first line import and all `ToolCall`/`Message` references with agent types:

```typescript
import type { AgentToolCall, AgentToolResult } from "../../agent/tools/types.js";
import type { AgentMessage } from "../../agent/types.js";

/**
 * Hook lifecycle — all hooks run inside the agent loop via AgentLoopConfig:
 *   1. user_prompt_submit → onUserPrompt
 *   2. pre_turn           → onPreTurn
 *   3. pre_tool_use       → onBeforeTool
 *   4. post_tool_use      → onAfterTool
 *   5. stop               → onStop
 */

export interface HookEvent {
  readonly type: string;
}

export interface UserPromptSubmitEvent extends HookEvent {
  readonly type: "user_prompt_submit";
  readonly prompt: string;
}

export interface PreTurnEvent extends HookEvent {
  readonly type: "pre_turn";
}

export interface PreToolUseEvent extends HookEvent {
  readonly type: "pre_tool_use";
  readonly call: AgentToolCall;
}

export interface PostToolUseEvent extends HookEvent {
  readonly type: "post_tool_use";
  readonly call: AgentToolCall;
  readonly result: AgentToolResult;
}

export interface StopEvent extends HookEvent {
  readonly type: "stop";
  readonly messages: readonly AgentMessage[];
}

export type HookEventUnion =
  | UserPromptSubmitEvent
  | PreTurnEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | StopEvent;

export interface HookResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly messages?: readonly AgentMessage[];
  readonly context?: string;
  readonly forceContinue?: string;
}

export interface Hook<TEvent extends HookEvent = HookEvent> {
  readonly name: string;
  readonly eventType: TEvent["type"];
  execute(event: TEvent): HookResult | void | Promise<HookResult | void>;
}
```

- [ ] **Step 2: Update `src/harness/agent-harness.ts`**

Replace the import section (lines 1-8) to use agent types:

```typescript
import { Agent } from "../agent/agent.js";
import type { AgentEvent, AgentMessage } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import type { AgentLoopConfig } from "../agent/types.js";
import { HookRegistry } from "./hooks/registry.js";
import type { Hook } from "./hooks/types.js";
import type { ModelConfig, StreamFn } from "../ai/types.js";
import { Session } from "./session/session.js";
import {
  CODING_SYSTEM_PROMPT,
  defaultSystemPrompt,
  type SystemPromptBuilder,
} from "./system-prompt.js";
```

Update `registryToLoopConfig` (lines 27-51) to use `AgentToolCall` from agent tools and add `model`/`convertToLlm` to the returned config. Since `AgentLoopConfig` now requires `model` and `convertToLlm`, and harness provides hooks, separate the two:

```typescript
/** Convert HookRegistry callbacks to AgentLoopConfig hook fields. */
function hooksToLoopConfig(registry: HookRegistry): Partial<AgentLoopConfig> {
  return {
    onUserPrompt: async (prompt) => {
      const r = await registry.trigger({ type: "user_prompt_submit", prompt });
      if (r?.block) return { block: true, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
      return undefined;
    },
    onPreTurn: async () => {
      const r = await registry.trigger({ type: "pre_turn" });
      if (r?.context) return { context: r.context };
      return undefined;
    },
    onBeforeTool: async (call) => {
      const r = await registry.trigger({ type: "pre_tool_use", call });
      if (r?.block) return { block: true, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
      return undefined;
    },
    onAfterTool: async (call, result) => {
      await registry.trigger({ type: "post_tool_use", call, result });
    },
    onStop: async (messages) => {
      const r = await registry.trigger({ type: "stop", messages });
      return r as { messages?: readonly AgentMessage[]; forceContinue?: string } | undefined;
    },
  };
}
```

Update `HarnessConfig` (line 16-24):

```typescript
export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly hookRegistry: HookRegistry;
  readonly systemPrompt?: SystemPromptBuilder;
  readonly cwd?: string;
}
```

Update the `constructor` — the config passed to `Agent` (lines 79-86) needs `model` and `convertToLlm` already merged with hooks. Since `Agent` constructor now takes hooks as `Omit<AgentLoopConfig, "model" | "convertToLlm">` and resolves defaults internally, pass the hooks part only. Change:

```typescript
// Old (lines 79-86):
this.agent = new Agent(
  config.streamFn,
  initialModel,
  config.toolRegistry,
  messages,
  systemPrompt,
  registryToLoopConfig(config.hookRegistry),
);

// New:
this.agent = new Agent(
  config.streamFn,
  initialModel,
  config.toolRegistry,
  messages,
  systemPrompt,
  hooksToLoopConfig(config.hookRegistry),
);
```

Update `get messages()` return type (line 151):

```typescript
get messages(): readonly AgentMessage[] {
  return this.agent.messages;
}
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: harness hooks + agent-harness use agent-layer types"
```

---

### Task 4: Update tests + final verification

**Files:**
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/agent/agent.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**
- Consumes: new `runAgentLoop` signature, `AgentMessage`, `AgentContext`, `AgentLoopConfig` from agent/types
- All existing test assertions unchanged

- [ ] **Step 1: Update `tests/agent/agent-loop.test.ts`**

Replace imports (lines 1-19):

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../../src/agent/types.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";
import { AgentTool, type AgentToolResult } from "../../src/agent/tools/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
```

Update `streamFnWithEvents` — the context parameter type changes from `Context` to something compatible. Since it's used only for assertions (`beforeStream` callback checks context.messages), keep it as `Context` (ai type) since the callback receives the LLM context constructed inside the loop:

No change needed — the callback still receives ai's `Context` because the test captures it at the LLM boundary.

Update all `runAgentLoop(...)` calls. Old pattern:

```typescript
// Old:
const history: Message[] = [];
const events = await collect(
  runAgentLoop(history, "", "hi", streamFn, testModel, new ToolRegistry()),
);
```

New pattern:

```typescript
// New:
const history: AgentMessage[] = [];
const events = await collect(
  runAgentLoop(
    "hi",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    { model: testModel, convertToLlm: (m) => m as Message[] },
    streamFn,
  ),
);
```

Replace every `runAgentLoop` call in the file following this pattern. The 6 calls are in these tests:

1. `"runAgentLoop streams text..."` (line 74-75)
2. `"runAgentLoop streams and executes tools sequentially"` (line 121)
3. `"tool results are in history..."` (line 179)
4. `"Registry failures are emitted..."` (line 202-203)
5. `"onBeforeTool blocks tool execution..."` (line 237)
6. `"onBeforeTool failure blocks tool execution..."` (line 266)

For tests 1-4, the config is `{ model: testModel, convertToLlm: (m) => m as Message[] }`.
For tests 5-6 (which use `AgentLoopConfig` hooks), spread the hooks into config:

```typescript
const config: AgentLoopConfig = {
  model: testModel,
  convertToLlm: (m) => m as Message[],
  onBeforeTool: async () => ({ block: true, reason: "blocked by test" }),
};
```

Change all `const history: Message[]` to `const history: AgentMessage[]` and `let secondHistory: readonly Message[]` to `let secondHistory: readonly AgentMessage[]`.

Change `registry: ToolRegistry` reference in helper to `AgentToolRegistry`. The `secondHistory` snapshot is now `AgentMessage[]` — update the type assertion accordingly. The `history.map(m => m.role)` and `history.at(-1)` assertions are unchanged since the shapes are identical.

- [ ] **Step 2: Update `tests/agent/agent.test.ts`**

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../../src/agent/agent.js";
import type { ModelConfig, StreamFn } from "../../src/ai/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";

const testModel: ModelConfig = { provider: "test", model: "test-model" };

const assistantMsg = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "hello" }],
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop" as const,
  latencyMs: 0,
};

const streamFn: StreamFn = async function* () {
  yield { type: "text_delta", text: "hello" };
  yield { type: "done", message: assistantMsg };
};

test("Agent owns conversation history across prompts", async () => {
  const agent = new Agent(streamFn, testModel, new AgentToolRegistry(), [], "system prompt");

  const events = [];
  for await (const event of agent.prompt("hi")) events.push(event.type);

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "text_delta",
    "turn_end",
    "agent_end",
  ]);
  assert.deepEqual(
    agent.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});
```

Key change: `assistantMsg` is no longer typed as `AssistantMessage` (from ai) but as a plain object literal. The `done` event's `message` field type is `AssistantMessage`, but the literal satisfies it. `StreamFn` returns `AssistantMessageEvent`, so `{ type: "done", message: assistantMsg }` is assignable.

- [ ] **Step 3: Check `tests/main.test.ts`**

Read the file and verify it still compiles. If it imports `ToolRegistry` or old types, update accordingly.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: passes with no errors. Fix any issues before proceeding.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass. Assertions unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: update tests for AgentMessage + AgentToolRegistry + new runAgentLoop signature"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Verify acceptance criteria**

Run grep to confirm no ai types leak where they shouldn't:

```bash
# agent-loop.ts should not import Context, AssistantMessage, ToolCall, Message from ai/types
grep -n "from.*ai/types" src/agent/agent-loop.ts
```

Expected output: only `AssistantMessageEvent, Context, Message, ModelConfig, StreamFn` — `Context` for the LLM boundary construction, `AssistantMessageEvent` for the stream event type, `Message` for convertToLlm return type, `ModelConfig` is allowed, `StreamFn` is the function type.

```bash
# AgentEvent should not reference ai types
grep -n "AssistantMessage\|ToolCall" src/agent/types.ts
```

Expected: `AgentToolCall` appears (agent type), not ai's `ToolCall`.

- [ ] **Step 4: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: final verification — clean type boundaries"
```
