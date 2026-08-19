# Agent：runAgentLoop、Tool 与事件契约

通用 agent 的三大能力之一——**agent-loop** 与 **tools**——以及它们共享的事件契约都定义在本包
`src/core/harness/` 下（顶层 `agent-loop.ts`、`types.ts`、`events.ts` 与 `tools/`）。这些是
无状态的运行机制：它们不持有 Session，不选择或调用模型，也不负责持久化。

session-bound 的组合根 `AgentHarness` 如何把这三者绑成一份 Session 的运行器，见
[harness.md](./harness.md)；Session 的模型、Repository 与持久化见 [session.md](./session.md)。
本包对外的基本使用方式见 [README.md](../README.md)。

## Events

事件契约统一由本包声明：顶层 [`events.ts`](../events.ts) 声明 `harness/*` 的 Run 边界、`agent/*`
的 Turn/流式/工具事实，以及两个控制拦截器（`agent/user-prompt`、`agent/context`）；
[`tools/events.ts`](../tools/events.ts) 声明 `tools/pre-execute`、`tools/execute`、
`tools/post-execute` 三个拦截阶段。这些文件没有运行时代码，只通过 `EventMap` 扩充声明类型。

```ts
// "harness/run-start": (input: AgentRunIdentity) => void | Promise<void>;
// "harness/run-end": (input: HarnessRunEnd) => void | Promise<void>;
// "agent/turn-start" | "agent/turn-end" | "agent/text-delta" ...（emit 事实）
// "agent/user-prompt" | "agent/context"（intercept 控制点）
// "tools/pre-execute" | "tools/execute" | "tools/post-execute"（intercept 控制点）
```

`harness/run-start` 表示 Harness 已经创建本次 Run 的身份和中止控制，即将进入 Agent；
`harness/run-end` 表示 Agent 已经结束，而且 Harness 已经清除了本次 Run 的运行状态。只要发布过
一次 `run-start`，就会在随后发布恰好一次 `run-end`。结束原因分别表示正常完成、主动中止和
运行失败；失败事件额外携带 `errorMessage`。

`AgentHarness` 使用调用方传入的 `Events`，并把同一个实例交给 Agent。多份 Harness 可以共享
一个实例；此时 listener 用 `AgentRunIdentity` 中的 `sessionId` 过滤目标 Session：

```ts
events.on("agent/turn-end", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  consume(input.message);
});
```

事件注册、错误隔离和取消规则完全沿用 [Events README](../../events/README.md)。

## Agent Loop

`runAgentLoop()` 是一次 Agent Run 的无状态驱动函数：每次调用 LLM 是一个 Turn，当 assistant
消息带 tool call 时顺序执行工具、保存结果并开始下一 Turn；没有 tool call 时结束。Agent Run
的身份、事件通道与取消信号都来自 `AgentContext`，所有完整消息都通过 `context.appendMessage()`
提交给拥有方（Harness 负责落盘），提交成功后才发布对应事实事件。

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
): Promise<void>;
```

- `AgentContext` 提供 Run 身份（`sessionId`、`runId`）、`cwd`、system prompt、消息、Tool
  Registry、共享 `Events` 与取消信号；`appendMessage()` 由 Harness 提供。
- `AgentLoopConfig` 携带本轮模型选择（`model`）、可选 `maxTurns` 上限和 `convertToLlm` 消息
  转换。
- `AgentRunIdentity`（`sessionId`、`runId`）让共享 dispatcher 上的 listener 按 Session 过滤，
  `runId` 关联一次 Run 的所有事件。

一个完整 Turn 的顺序为 `agent/turn-start` → `agent/context`（整理消息快照）→ 流式
`agent/text-delta`/`agent/thinking-delta`/`agent/tool-call-start`/`agent/tool-call-delta` →
`done` 终止块后完整 assistant 消息写入 → 逐个执行 Tool → `agent/turn-end`。Turn 后是否继续
由 Loop 内建决定：本轮有 Tool Result 就继续让模型消费；没有则结束。`maxTurns` 是不可绕过的
硬上限。模型返回 `error` 终止块时 Run 结束；Stream 缺终止块时 Run 失败。

## Tool

`AgentTool` 定义工具 schema 与执行，`AgentToolRegistry` 是工具的唯一执行入口：它接收原始
`AgentToolCall`，内部完成 lookup、TypeBox 校验，并把执行过程交给三个拦截阶段
（`tools/pre-execute`、`tools/execute`、`tools/post-execute`）。`execute()` 的最终 handler 通过
timeout helper 调用 `AgentTool.execute()`，并把抛出的异常归一化为错误结果。具体 Tool 只收到
验证后的参数与合并后的 timeout signal，不知道 Session、Run 或 Events。

- `AgentTool<TParameters, TDetails>`：`validate()` 校验参数，`execute()` 返回
  `AgentToolResult<TDetails>`（`content` 模型可见，`details` 结构化）；
- `AgentToolRegistry`：`register()`/`unregister()`/`schemas()`/`all()`/`execute(call, context)`；
- `ToolExecutionContext` 是执行环境（Run 身份、`cwd`、`Events`、取消信号），`call` 作为
  `execute()` 第一个参数独立传入。

未知、无效、被阻止、已中止或失败的调用都会以恰好一个 `agent/tool-result` 结束。

## 类型

Loop 与 Tool 共享的核心类型定义在 [`types.ts`](../types.ts)：

- `AgentMessage`：agent 层消息，当前是 ai 层 `Message` 的别名；
- `AgentRunIdentity`：`{ sessionId, runId }`，标识一次 Agent Run；
- `AgentContext`：一次 Run 的状态（身份、system prompt、消息、Tool Registry、`Events`、
  取消信号与 `appendMessage`）；
- `AgentLoopConfig`：一次 Run 的循环策略（`model`、`maxTurns`、`convertToLlm`）；
- `StreamFn`：Loop 所需的最小模型执行能力，可由 `runtime.stream.bind(runtime)` 提供；
- `HarnessConfig`：构造 `AgentHarness` 的依赖（见 [harness.md](./harness.md)）。
