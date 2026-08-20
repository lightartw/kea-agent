# Agent：runAgentLoop、Tool、事件与钩子契约

通用 agent 的三大能力之一——**agent-loop** 与 **tools**——以及它们的观察事件与控制钩子契约都定义
在本包 `src/core/harness/` 下（顶层 `agent-loop.ts`、`types.ts`、`events.ts`、`hooks.ts` 与
`tools/`）。这些是无状态的运行机制：它们不持有 Session，不选择或调用模型，也不负责持久化。

session-bound 的组合根 `AgentHarness` 如何把这三者绑成一份 Session 的运行器，见
[harness.md](./harness.md)；Session 的模型、Repository 与持久化见 [session.md](./session.md)。
本包对外的基本使用方式见 [README.md](../README.md)。

## 观察事件与控制钩子分离

本包把"观察"与"控制"明确分开：

- **观察事件**（`events.ts`）：`HarnessEventBus` 只发布已发生的事实，listener 返回 `void`。
  事件类型是 `HarnessEvent` 的判别联合：`run-start`、`run-end`、`turn-start`、`turn-end`、
  `text-start`/`text-end`、`thinking-start`/`thinking-end`、`text-delta`、`thinking-delta`、
  `tool-call-start`、`tool-call-delta`、`tool-call`、`tool-result`。事件携带 `runId`（无
  `sessionId`，因为每个 Harness 已绑定一份 Session）。
- **控制钩子**（`hooks.ts`）：`HarnessHooks` 是一组**固定命名**的点，handler 通过返回值影响
  流程：
  - `beforePrompt(prompt, ctx)` → `string | undefined`（改写用户 prompt；返回 `undefined` 停止 Run）；
  - `transformContext(messages, ctx)` → 消息（整理每次 LLM 请求的快照，不改写 Session 历史）；
  - `beforeTool(call, ctx)` → `PreToolDecision`（`{allow} | {deny, reason?}`，权限用；首个 `deny`
    短路）。

多 handler 通过统一原语组合：变换钩子链式传递，`beforeTool` 首个 `deny` 短路。

`run-start` 表示 Harness 已经创建本次 Run 的身份和中止控制，即将进入 Agent；`run-end` 表示
Agent 已经结束，且 Harness 已经清除了本次 Run 的运行状态。只要发布过一次 `run-start`，就会在
随后发布恰好一次 `run-end`；结束原因分别表示正常完成、主动中止和运行失败，失败事件额外携带
`errorMessage`。

每个 `AgentHarness` 自持一个 `HarnessEventBus` 与一个 `HarnessHooks`（由调用方创建并注入
`HarnessConfig`）。listener 通过 `harness.subscribe(...)` 注册；控制钩子由调用方在创建
`HarnessHooks` 时注册（如 coding-agent 的权限作为 `beforeTool`）。

## Agent Loop

`runAgentLoop()` 是一次 Agent Run 的无状态驱动函数：每次调用 LLM 是一个 Turn，当 assistant
消息带 tool call 时顺序执行工具、保存结果并开始下一 Turn；没有 tool call 时结束。Agent Run
的身份、观察事件总线、控制钩子与取消信号都来自 `AgentContext`，所有完整消息都通过
`context.appendMessage()` 提交给拥有方（Harness 负责落盘），提交成功后才发布对应事实事件。

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
): Promise<void>;
```

- `AgentContext` 提供 Run 身份（`sessionId`、`runId`）、`cwd`、system prompt、消息、Tool
  Registry、观察总线 `events`、控制钩子 `hooks` 与取消信号；`appendMessage()` 由 Harness 提供。
- `AgentLoopConfig` 携带本轮模型选择（`model`）、可选 `maxTurns` 上限和 `convertToLlm` 消息
  转换。
- `AgentRunIdentity`（`sessionId`、`runId`）标识一次 Agent Run；`runId` 关联一次 Run 的所有事件。

一个完整 Turn 的顺序为 `turn-start` → `hooks.transformContext`（整理消息快照）→ 流式
`text-delta`/`thinking-delta`/`tool-call-start`/`tool-call-delta` → `done` 终止块后完整
assistant 消息写入 → 逐个执行 Tool → `turn-end`。用户 prompt 先经 `hooks.beforePrompt` 处理。
Turn 后是否继续由 Loop 内建决定：本轮有 Tool Result 就继续让模型消费；没有则结束。`maxTurns`
是不可绕过的硬上限。模型返回 `error` 终止块时 Run 结束；Stream 缺终止块时 Run 失败。

## Tool

`AgentTool` 定义工具 schema 与执行，`AgentToolRegistry` 是工具的唯一执行入口：它接收原始
`AgentToolCall`，内部完成 lookup、TypeBox 校验，然后调用 `hooks.beforeTool` 做权限决策；拒绝则
返回错误结果。允许后通过 timeout helper 调用 `AgentTool.execute()`，并把抛出的异常归一化为错误
结果。具体 Tool 只收到验证后的参数与合并后的 timeout signal，不知道 Session、Run 或事件。

- `AgentTool<TParameters, TDetails>`：`validate()` 校验参数，`execute()` 返回
  `AgentToolResult<TDetails>`（`content` 模型可见，`details` 结构化）；
- `AgentToolRegistry`：`register()`/`unregister()`/`schemas()`/`all()`/`execute(call, context)`；
- `ToolExecutionContext` 是执行环境（Run 身份、`cwd`、控制钩子 `hooks`、取消信号），`call` 作为
  `execute()` 第一个参数独立传入。

未知、无效、被阻止、已中止或失败的调用都会以恰好一个 `tool-result` 事件结束。

## 类型

Loop 与 Tool 共享的核心类型定义在 [`types.ts`](../types.ts) 与 [`hooks.ts`](../hooks.ts)：

- `AgentMessage`：agent 层消息，当前是 ai 层 `Message` 的别名；
- `AgentRunIdentity`：`{ sessionId, runId }`，标识一次 Agent Run；
- `AgentContext`：一次 Run 的状态（身份、system prompt、消息、Tool Registry、观察总线 `events`、
  控制钩子 `hooks`、取消信号与 `appendMessage`）；
- `AgentLoopConfig`：一次 Run 的循环策略（`model`、`maxTurns`、`convertToLlm`）；
- `StreamFn`：Loop 所需的最小模型执行能力，可由 `runtime.stream.bind(runtime)` 提供；
- `HookName`/`HookContext`/`PreToolDecision`：控制钩子的契约；
- `HarnessConfig`：构造 `AgentHarness` 的依赖（见 [harness.md](./harness.md)）。
