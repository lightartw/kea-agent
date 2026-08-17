# agent

`agent` 通过自己定义的 `StreamFn` 使用 ai 流协议，并实现多 turn 工具循环。

一次 `runAgentLoop()` 调用是一个 **Agent Run**；每次调用 LLM 是一个 **Turn**。当 assistant 消息
带 tool call 时，Agent 顺序执行工具、保存结果并开始下一 turn；没有 tool call 时结束。Harness
在一次 Harness run 中驱动恰好一个 Agent Run。

agent 包分为两部分：

1. `runAgentLoop`：不持有会话状态的一次 Agent Run 驱动函数。
2. `AgentTool` 与 `AgentToolRegistry`：工具定义、校验和执行。

控制与事实都通过共享的 `Events` 分发（见 [events/README.md](../events/README.md)）；本包在
`src/core/agent/events.ts` 和 `src/core/agent/tools/events.ts` 中声明 Agent 与 Tool 命名空间的事件契约。
有状态的 `AgentHarness` 属于同级 `harness` 包。

## 1. 一次 AI 请求与一次 Agent Run

一次 `StreamFn` 调用完成一次 LLM 请求。一次 Agent Run 可能包含多次 LLM 请求：模型先输出
assistant message，Agent 执行其中请求的 Tool，把 Tool Result 写回历史，再请求一次模型让它
读取结果。`runAgentLoop()` 驱动这整个过程：本轮产生 Tool Result 时开始下一 Turn，让模型消费
结果；没有 Tool Result 时结束 Run。

## 2. 类型

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): Promise<void>;

interface AgentContext {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolRegistry;
  appendMessage(message: AgentMessage): Promise<void>;
}

interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** 一次 Run 已完成模型 Turn 的硬上限。 */
  readonly maxTurns?: number;
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
  readonly events: Events;
  readonly run: AgentRunIdentity;
}

interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
}
```

`AgentMessage` 是 ai 层 `Message` 的别名。`AgentRunIdentity`（`sessionId`、`runId`）标识一次
Agent Run：`sessionId` 让共享 dispatcher 上的 listener 按 Session 过滤，`runId` 关联一次 Run
的所有事件。所有完整消息都通过 `context.appendMessage()` 提交给
拥有方（Harness 负责落盘），提交成功后才发布对应的事实事件。Loop 不直接修改
`context.messages`。

## 3. 一个完整的 Turn

一个 Turn 从 `agent/turn-start` 开始，到 `agent/turn-end` 结束，包括：

1. `agent/context` 整理本次请求的消息快照；
2. 调用模型，流式输出 `agent/text-delta`、`agent/thinking-delta`、
   `agent/tool-call-start`、`agent/tool-call-delta`；
3. 收到 `done` 终止块后，完整 assistant message 写入 Session；
4. 若 assistant 消息带 Tool Call，按源顺序执行每个 Tool（见第 5 节），每个调用产生一个
   `agent/tool-call` 与一个 `agent/tool-result`；
5. 发布 `agent/turn-end`，携带 `message` 和本轮全部 `toolResults`。

`agent/turn-end` 只在所有 Tool Result 持久化后发布。模型返回 `error` 终止块时，错误 assistant
message 仍会写入并产生一个空结果的 `agent/turn-end`，然后 Run 结束，不执行不完整响应中的
Tool Call。Stream 在无终止块时结束会让 Run 失败，不发布 `agent/turn-end`。

## 4. Tool 定义与 Registry

```ts
interface AgentToolResult<TDetails = unknown> {
  readonly content: string;
  readonly details?: TDetails;
  readonly isError: boolean;
}

interface AgentToolCall {
  readonly type: "toolCall"; readonly id: string;
  readonly name: string; readonly arguments: Record<string, unknown>;
}

abstract class AgentTool<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> implements Tool {
  protected constructor(name: string, description: string, parameters: TParameters);
  validate(arguments_: unknown): string | undefined;
  abstract execute(
    args: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}

class AgentToolRegistry {
  constructor(timeout?: number);  // 秒，默认 120
  register(tool: AgentTool): void;
  unregister(name: string): void;
  schemas(): Tool[];
  all(): AgentTool[];
  execute(
    call: AgentToolCall,
    events: Events,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
}
```

Registry 是 Tool 的唯一执行入口：它接收原始 `AgentToolCall`，内部完成 lookup、TypeBox 校验，
并把执行过程交给三个 Tool 拦截阶段（见第 5 节）。`execute()` 的最终 `handler` 通过 timeout
helper 调用 `AgentTool.execute()`，并把抛出的异常归一化为错误结果。

## 5. Tool 拦截：pre-execute / execute / post-execute

每个 Tool Call 在 `AgentToolRegistry.execute()` 内经过三个 `intercept()` 阶段，均由
`src/core/agent/tools/events.ts` 声明：

- **`tools/pre-execute`**：接收原始 call，返回 `PreToolDecision`。listener 调用
  `proceed(call)` 以继续检查，或返回可选原因的 `deny` 以阻止执行。Registry 收到 `deny`
  后统一生成错误 `AgentToolResult`。`proceed(changedCall)` 会把值交给后续 pre-execute
  listener，但这个阶段的最终结果只有 allow/deny；所有 listener 都允许后，Registry 使用传给
  `execute()` 的原始 call 做 lookup 和 TypeBox 验证。
- **`tools/execute`**：以已经 lookup、验证过的 call 作为初始输入，最终 handler 使用这一阶段
  传到末端的 `call.arguments` 运行之前选中的 Tool。listener 可以包裹执行，也可以通过
  `proceed(changedCall)` 改变实际执行参数；Registry 不会在这一阶段重新 lookup 或验证。
- **`tools/post-execute`**：接收 `{ call, result }`，listener 可以在结果写入 Session 前修改它。
  最终 handler 原样返回 `input.result`。

未知、参数无效、被阻止或已中止的调用跳过无法执行的阶段，但 `execute()` 仍返回一个错误
`AgentToolResult`。listener 抛出的错误被归一化为当前调用自己的错误结果，不会影响其他调用或
Session。

## 6. Agent 事实事件顺序

一个成功执行 Tool 的 Turn 的事件顺序：

```text
agent/turn-start
agent/context
agent/text-delta | agent/thinking-delta | agent/tool-call-start | agent/tool-call-delta
agent/tool-call
tools/pre-execute
tools/execute
tools/post-execute
agent/tool-result
agent/turn-end
maxTurns hard-limit check
stop when toolResults is empty
```

四个流式事实只在 provider 产生对应片段时发生。Tool 拦截五行对每个 Tool Call 重复一次。若
`maxTurns` 未达到且本轮产生了 Tool Result，下一个 `agent/turn-start` 开始新一轮；否则 Run 结束。

## 7. Agent 控制事件

Agent 有两个 `intercept()` 控制点：

- **`agent/user-prompt`**：user message 写入前，listener 可返回修改后的 prompt，或返回
  `undefined` 阻止 Run；
- **`agent/context`**：每次模型请求前整理消息快照，不改写 Session 历史。

Turn 后是否继续不是扩展点，而是 Loop 的内建结构规则：`toolResults.length === 0` 时结束，否则继续。
`maxTurns` 是在这条规则前检查的硬限制。AI `error` 终止块会直接结束 Run。

## 8. 与 Harness 的关系

位于 sibling 包 `harness/`。`AgentHarness` 从 Session 取得当前路径的消息、管理 `activeRun`、
构造 `AgentRunIdentity`，并通过共享的 `Events` 调用 `runAgentLoop()`。详见
[harness/README.md](../harness/README.md)。

## 9. 完整公开导出

从 `src/core/agent/index.ts`：
- `runAgentLoop`

从 `src/core/agent/tools/index.ts`：
- `AgentTool`, `AgentToolRegistry`
- `AgentToolCall`, `AgentToolResult`, `PreToolDecision`

从 `src/core/agent/types.ts`（经根入口）：
- `AgentContext`, `AgentLoopConfig`, `AgentMessage`, `AgentRunIdentity`, `StreamFn`

## 10. 包边界

agent 只从相邻 ai 层直接依赖：

| ai 接口 | agent 用途 |
|---------|-----------|
| `ModelConfig` | model/provider 选择 |
| `Message` | `AgentMessage` 和转换结果 |
| `Context` | 调用 LLM 前临时构造 |
| `StreamChunk` | loop 消费 ai stream |
| `Tool` | `AgentTool` schema 契约 |

`StreamFn` 由 agent 定义，是 Loop 所需的最小模型执行能力。上层可以用
`runtime.stream.bind(runtime)` 提供实现；Loop 不接收完整 `ModelRuntime`，也不能调用 `complete()`。

其他依赖：

- `typebox`、`typebox/compile`：工具参数类型和校验；
- `events/`：共享 `Events` dispatcher 与 `EventMap` 契约；
- `core/util`：仅供 core 内部使用的错误与 timeout helper；
- 不依赖 core 上层包或具体工具实现。
