# Agent Type Boundary — `AgentMessage` + `AgentToolCall` 解耦

**Date:** 2026-07-25

## Summary

`agent-loop.ts` 当前全程操作 ai 层的 `Message` / `ToolCall` / `Context` / `AssistantMessage`，没有自己的领域类型。这导致 agent 包对 ai 包形成结构耦合 —— 添加自定义消息类型、修改 tool call 语义都需要穿透到 loop 内部。

参考 Pi agent 的设计，引入 `AgentMessage`（agent 层的消息类型别名）和 `AgentToolCall`（agent 层的工具调用结构），在 loop 内部建立 `convertToLlm` 边界：loop 全场用 agent 层类型，只在调用 LLM 前转换一次。同时收束 `runAgentLoop` 的 8 个位置参数为 5 个结构化参数。

## Goals

- agent 包内部类型独立于 ai 包：`AgentMessage`、`AgentToolCall`、`AgentContext`、`AgentLoopConfig`
- `runAgentLoop` 参数从 8 个缩到 5 个，通过 `AgentContext` 和 `AgentLoopConfig` 结构化
- `AgentToolRegistry` 替代 `ToolRegistry`（命名更清晰）
- LLM 消息转换通过 `config.convertToLlm` 集中在一处
- `AgentEvent` 不暴露 ai 类型
- `agent-loop.ts` 纯函数，不自行提供 `convertToLlm` 默认实现
- Agent 类提供默认 `convertToLlm`（identity）

## Non-goals

- 不引入并发工具执行
- 不升级 `ModelConfig` 为完整 `Model` 对象
- 不改 `AgentToolResult` 结构（`{ content: string, isError: boolean }` 暂可扩展）
- 不改 Session（harness 持久化层）
- 不引入 declaration merging（`AgentMessage = Message` 简单 alias）

## New Types

### `agent/tools/types.ts`

```typescript
// 新增：工具调用结构，与 AgentToolResult 放在一起（tool 执行的输入/输出对）
export interface AgentToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

### `agent/types.ts`

```typescript
import type { Message, ModelConfig } from "../ai/types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";

// ── Agent 层消息 —— agent 包内部只用此类型 ──
export type AgentMessage = Message;

// ── 上下文 —— 收束 messages / systemPrompt / tools ──
export interface AgentContext {
  readonly systemPrompt: string;
  messages: AgentMessage[];
  readonly tools: AgentToolRegistry;
}

// ── 配置 —— 收束 model / hooks / convertToLlm ──
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];

  // 生命周期 hooks
  readonly onUserPrompt?: (prompt: string) => Promise<{ block: boolean; reason?: string } | undefined>;
  readonly onPreTurn?: () => Promise<{ context: string } | undefined>;
  readonly onBeforeTool?: (call: AgentToolCall) => Promise<{ block: boolean; reason?: string } | undefined>;
  readonly onAfterTool?: (call: AgentToolCall, result: AgentToolResult) => Promise<void>;
  readonly onStop?: (messages: readonly AgentMessage[]) => Promise<{
    messages?: readonly AgentMessage[];
    forceContinue?: string;
  } | undefined>;
}

// ── 事件 —— 不暴露 ai 类型 ──
export type AgentEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end";   readonly messages: readonly AgentMessage[] }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end";    readonly message: AgentMessage }
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: AgentToolCall }
  | { readonly type: "tool_start";      readonly call: AgentToolCall }
  | { readonly type: "tool_end";        readonly call: AgentToolCall; readonly result: AgentToolResult };

// ── 公共状态 —— 不暴露 ai 类型 ──
export interface AgentState {
  readonly messages: readonly AgentMessage[];
  readonly model: ModelConfig;
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
```

### `agent-loop.ts` 新签名

```typescript
// 旧（8 参数）
async function* runAgentLoop(
  messages: Message[], systemPrompt: string, input: string,
  streamFn: StreamFn, model: ModelConfig, registry: ToolRegistry,
  config?: AgentLoopConfig, signal?: AbortSignal,
): AsyncIterable<AgentEvent>

// 新（5 参数）
async function* runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent>
```

## Internal Changes (`agent-loop.ts`)

### convertToLlm 边界

loop 只在即将调用 LLM 时转换消息：

```typescript
const llmMessages = config.convertToLlm(context.messages);
const llmContext: Context = {
  systemPrompt: context.systemPrompt,
  messages: llmMessages,
  tools: context.tools.schemas(),
};

for await (const event of streamFn(config.model, llmContext, ...)) {
  // ...
}
```

### 消息操作

所有 `messages.push(...)` → `context.messages.push(...)`。构造 user message 时用字面量形状（`{ role: "user", content: input }`），该形状同时满足 `AgentMessage` 和 ai 的 `Message`（当前它们是 alias）。

### AI 事件 → AgentEvent

`streamFn` 返回 ai 的 `AssistantMessageEvent`。loop 在 switch 中逐分支映射到 `AgentEvent`。`toolcall_end` 分支提取 `event.toolCall`（ai 的 `ToolCall`）构造 `AgentToolCall`：

```typescript
case "toolcall_end":
  toolCalls.push({
    type: "toolCall",
    id: event.toolCall.id,
    name: event.toolCall.name,
    arguments: event.toolCall.arguments,
  });
  // yield AgentEvent with AgentToolCall
```

AI 特有的字段（如 `AssistantMessage.model`, `AssistantMessage.usage`, `AssistantMessage.latencyMs`）留在 `AgentMessage` 内（因为是 alias，字段都在），但消费者不依赖它们。

## Agent Tool Registry 重命名

```
ToolRegistry → AgentToolRegistry
```

文件：`src/agent/tools/registry.ts`。所有引用处同步重命名。

`execute()` 签名使用 `AgentToolCall`：

```typescript
execute(call: AgentToolCall): Promise<AgentToolResult>
```

## Agent 类适配 (`agent.ts`)

### 默认 convertToLlm

```typescript
private static defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages;  // AgentMessage = Message，identity
}
```

构造函数中合并进 `AgentLoopConfig`：

```typescript
this.config = {
  model: this._model,
  convertToLlm: this.convertToLlm ?? Agent.defaultConvertToLlm,
  ...config,
};
```

### prompt() 适配新签名

```typescript
async *prompt(input: string): AsyncIterable<AgentEvent> {
  for await (const event of runAgentLoop(
    input,
    {
      systemPrompt: this._systemPrompt,
      messages: this.history,
      tools: this._registry,
    },
    this.config,          // 已包含 model + convertToLlm + hooks
    this._streamFn,
    abortController.signal,
  )) { yield event; }
}
```

## Harness 适配 (`harness/agent-harness.ts`)

`HarnessConfig` 和 `registryToLoopConfig` 函数中的类型引用更新：

- `ToolRegistry` → `AgentToolRegistry`
- `Message` → `AgentMessage`（`AgentLoopConfig` 回调中的 `messages`）

逻辑不变，纯类型迁移。`agent-harness.ts` 中的 `get messages()` 返回类型保持对应。

`harness/hooks/types.ts` 中的 `PreToolUseEvent.call`、`PostToolUseEvent.call` 从 ai 的 `ToolCall` 改为 `AgentToolCall`，`StopEvent.messages` 从 `Message[]` 改为 `AgentMessage[]`。

## Migration Map

| 文件 | 改动 |
|---|---|
| `src/agent/types.ts` | 新增 `AgentMessage`、`AgentContext`；`AgentLoopConfig` 加入 `model`/`convertToLlm`；`AgentEvent`/`AgentState` 改用 agent 类型；移除对 `AssistantMessage`/`ToolCall` 的 import |
| `src/agent/tools/types.ts` | 新增 `AgentToolCall` 定义；`AgentTool` 仍实现 ai 的 `Tool`，不变 |
| `src/agent/agent-loop.ts` | 新签名（5 参数）；全程用 `AgentMessage`/`AgentToolCall`；`convertToLlm` 边界；不再 import `Context`/`AssistantMessage` |
| `src/agent/agent.ts` | 新增 `defaultConvertToLlm`；`prompt()` 适配新签名；`history: AgentMessage[]`；`ToolRegistry` → `AgentToolRegistry` |
| `src/agent/tools/registry.ts` | `ToolRegistry` → `AgentToolRegistry`；`execute(call: AgentToolCall)` |
| `src/harness/hooks/types.ts` | `ToolCall` → `AgentToolCall`；`Message` → `AgentMessage` |
| `src/harness/agent-harness.ts` | 类型引用更新；`registryToLoopConfig` 适配 |
| `tests/agent/agent-loop.test.ts` | 适配新签名和类型 |
| `tests/agent/agent.test.ts` | 适配新签名和类型 |

## Acceptance Criteria

- [ ] TypeScript 编译通过 (`npm run typecheck`)
- [ ] 所有现有测试通过，断言不改变
- [ ] `agent-loop.ts` 不再 import `Context`/`AssistantMessage`/`ToolCall`/`Message` 从 `ai/types`
- [ ] `AgentEvent` 和 `AgentState` 不暴露 ai 的 `Message`/`AssistantMessage`/`ToolCall`
- [ ] `AgentLoopConfig` 仅通过 `model`/`convertToLlm` 引用 ai 类型
- [ ] `AgentToolCall` 是独立定义的结构，不依赖 ai
- [ ] `AgentToolRegistry` 替代 `ToolRegistry`，无残留旧名
- [ ] Harness 层逻辑不变，纯类型迁移
