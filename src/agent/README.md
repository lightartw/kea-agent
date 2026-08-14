# agent

`agent` 在 `ai.StreamFn` 之上实现多 turn 工具循环。

一次 `runAgentLoop()` 调用是一个 **Agent Run**；每次调用 LLM 是一个 **Turn**。当 assistant 消息
带 tool call 时，Agent 顺序执行工具、保存结果并开始下一 turn；没有 tool call 时结束。Harness
在一次 Harness run 中驱动恰好一个 Agent Run。

agent 包分为两部分：

1. `runAgentLoop`：纯函数，一次 Agent Run 的驱动。
2. `AgentTool` 与 `AgentToolRegistry`：工具定义、校验和执行。

控制与事实都通过共享的 `Events` 分发（见 [events/README.md](../events/README.md)）；本包在
`src/agent/events.ts` 和 `src/agent/tools/events.ts` 中声明 Agent 与 Tool 命名空间的事件契约。
有状态的 `AgentHarness` 属于同级 `harness` 包。

## 1. 一次 AI 请求与一次 Agent Run

一次 `StreamFn` 调用完成一次 LLM 请求。一次 Agent Run 可能包含多次 LLM 请求：模型先输出
assistant message，Agent 执行其中请求的 Tool，把 Tool Result 写回历史，再请求一次模型让它
读取结果。`runAgentLoop()` 驱动这整个过程，直到模型不再请求 Tool 且 Run 结束。

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
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
  readonly events: Events;
  readonly run: AgentRunIdentity;
}

interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly lane: string;
}
```

`AgentMessage` 是 ai 层 `Message` 的别名。所有完整消息都通过 `context.appendMessage()` 提交给
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
`src/agent/tools/events.ts` 声明：

- **`tools/pre-execute`**：接收原始 call。listener 可以修改 call 或直接返回一个
  `AgentToolResult` 以阻止执行（例如 Permission 拒绝）。未阻止时，Registry 用返回的 call 做
  lookup 和验证。
- **`tools/execute`**：接收有效 call，最终 handler 运行 Tool 本体。listener 可以在这里包一层
  计时、日志或额外校验。
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
```

四个流式事实只在 provider 产生对应片段时发生。Tool 拦截五行对每个 Tool Call 重复一次。若
`shouldContinue()` 决定继续，下一个 `agent/turn-start` 开始新一轮；否则 Loop 拦截
`agent/stopping` 作为最后一个扩展点。

## 7. Agent 控制事件

Agent 有三个 `intercept()` 控制点：

- **`agent/user-prompt`**：user message 写入前，listener 可返回 `undefined` 阻止 Run；
- **`agent/context`**：每次模型请求前整理消息快照，不改写 Session 历史；
- **`agent/stopping`**：仅当 Loop 即将停止时拦截，listener 可返回一条消息以开始下一 Turn。

`shouldContinue()` 是 Loop 内部的决策（`toolResults` 非空且未 Abort 时继续），不产生事件。
`agent/stopping` 是唯一在 Loop 即将停止时出现的扩展点。

## 8. 与 Harness 的关系

位于 sibling 包 `harness/`。`AgentHarness` 持有 `_messages`、管理 `activeRun`、构造
`AgentRunIdentity`，并通过共享的 `Events` 调用 `runAgentLoop()`。详见
[harness/README.md](../harness/README.md)。

## 9. 完整公开导出

从 `src/agent/events.ts`：
- `AgentRunIdentity`

从 `src/agent/tools/index.ts`：
- `AgentTool`, `AgentToolRegistry`
- `AgentToolCall`, `AgentToolResult`

从 `src/agent/types.ts`（经根入口）：
- `AgentContext`, `AgentLoopConfig`, `AgentMessage`

## 10. 与 UI 的解耦

agent 层（以及其上的 coding-agent 层）从不 import 任何 UI/CLI 类型。UI 通过两种机制注入，
二者都遵循依赖倒置（DI）：

- **控制拦截**：Permission 等 listener 注册在共享 `Events` 上并闭包捕获
  `CodingAgentInteractions`；Agent 的 dispatcher 不打开 context 盒子，listener 自己持有依赖。
- **Tool 构造注入**：`AgentTool.execute(args, timeoutSignal)` 没有 context/UI 参数。工具由
  coding-agent 的 `ToolDefinition` 在 `createProject()` 中经包内翻译成为 `AgentTool`。

「用户确认」这类 UI 交互不是工具职责，而是策略职责。Permission listener 在
`tools/pre-execute` 阶段执行 allow/ask 策略，也拒绝 hard-deny 命令；Bash Tool 自身再次检查
hard-deny，形成纵深防御。

## 11. 包边界

agent 只从相邻 ai 层直接依赖：

| ai 接口 | agent 用途 |
|---------|-----------|
| `StreamFn` | 注入 LLM 能力 |
| `ModelConfig` | model/provider 选择 |
| `Message` | `AgentMessage` 和转换结果 |
| `Context` | 调用 LLM 前临时构造 |
| `StreamChunk` | loop 消费 ai stream |
| `Tool` | `AgentTool` schema 契约 |

其他依赖：

- `typebox`、`typebox/compile`：工具参数类型和校验；
- `events/`：共享 `Events` dispatcher 与 `EventMap` 契约；
- `utils/timeout`：工具 timeout；
- 不依赖 coding-agent、UI 或具体工具实现。
