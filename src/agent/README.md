# agent

`agent` 在 `ai.StreamFn` 之上实现多 turn 工具循环。

一次 `runAgentLoop()` 调用是一个 **Agent Run**；每次调用 LLM 是一个 turn。当 assistant 消息带
tool call 时，Agent 顺序执行工具、保存结果并开始下一 turn；没有 tool call 时结束。Harness 在
一次 Harness run 中驱动恰好一个 Agent Run。

agent 包分为两部分：

1. `runAgentLoop`：纯函数，一次 Agent Run 的驱动。
2. `AgentTool` 与 `AgentToolRegistry`：工具定义、校验和执行。

控制与事实都通过共享的 `Events` 分发（见 [events/README.md](../events/README.md)）；本包在
`src/agent/events.ts` 中声明 Agent 命名空间的事件契约。有状态的 `AgentHarness` 属于同级
`harness` 包。

## 一次 Run

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

`runAgentLoop()` 返回 `Promise<void>`，不持有实例状态。所有完整消息都通过
`context.appendMessage()` 提交给拥有方（Harness 负责落盘），提交成功后才发布对应的事实事件。
Loop 不直接修改 `context.messages`。

执行顺序：

1. 通过 `events.ask("agent/user-prompt", ...)` 检查拦截；返回 `block: true` 时直接结束。
2. 未被拦截则 `appendMessage` 写入 user message。
3. 每个 turn 复制历史消息，通过 `events.transform("agent/context", ...)` 变换本次请求上下文。
4. 用 `convertToLlm` 构造 ai `Context`，消费 `StreamFn`。每轮 Stream 必须以 `done` 或 `error`
   终止；Stream 在无终止块时结束会让 Run 失败，且不发布 `agent/turn-end`。
5. 无 tool call 时 `events.ask("agent/stop", ...)`，`continueWith` 非空时添加消息并开始下一 turn。
6. 有 tool call 时逐个处理（见下方生命周期）。
7. AI 错误和 Abort 不触发 `stop`。

### 工具调用生命周期

每个来自最终 assistant message 的 `AgentToolCall` 恰好产生一个终态：

```text
agent/tool-call (transform) -> prepare -> tool_start -> execute -> agent/tool-result (transform)
                            -> ToolResultMessage -> tool_end

transform 返回 reject / prepare 被拒绝 -> ToolResultMessage -> tool_rejected
```

细节：

- 原始 call 的 `arguments` 先 `structuredClone` 成工作副本放进 `ToolCallDecision`，再交给
  `agent/tool-call` transform 修改；`tool_rejected.call.arguments` 始终是模型原始对象，
  处理后的参数放在 `effectiveArguments`。
- `prepare()` 完成 lookup 和最终参数验证；只有 `ready` 才发射 `tool_start` 并执行。
- 被拒绝、参数无效、工具不存在或已 Abort 的调用，合成一条 synthetic
  `ToolResultMessage` 并发射恰好一个 `tool_rejected`，不会静默丢失。
- 批处理中途 Abort 时，已开始的调用照常 `tool_end`，其余调用各得一个 `aborted`
  的 `tool_rejected`。
- Abort 优先于迟到的 listener 返回值：信号在 transform/ask 等待期间触发时，
  结果按 `aborted` 分类。

## Agent 事件契约

`src/agent/events.ts` 通过模块扩充把以下契约加入 `EventMap`。事件名以 `agent/` 为前缀，
每个事件都携带 `AgentRunIdentity`（`sessionId`、`runId`、`lane`）。

### 控制事件（ask / transform）

| 事件 | 模式 | 作用 |
|------|------|------|
| `agent/user-prompt` | ask | 提交 user message 前允许或阻止 |
| `agent/context` | transform | 每次 LLM 请求前转换消息快照 |
| `agent/tool-call` | transform | 执行前替换参数或返回终止性 reject |
| `agent/tool-result` | transform | 提交 Tool Result 前修改结果 |
| `agent/stop` | ask | Agent 停止前请求继续 |

`ToolCallDecision` 是 `agent/tool-call` 的输入/输出：

```ts
type ToolCallDecision =
  | (AgentRunIdentity & { kind: "execute"; call: AgentToolCall })
  | (AgentRunIdentity & { kind: "reject"; call: AgentToolCall; reason: string });
```

listener 返回新 decision 或传给 `next()`，不得改写模型的原始 `AgentToolCall`。

### 事实事件（emit）

| 事件 | 载荷 |
|------|------|
| `agent/turn-start` | 身份 |
| `agent/turn-end` | 完整 assistant message |
| `agent/text-delta` | 文本增量 |
| `agent/thinking-delta` | 思考增量 |
| `agent/toolcall-start` / `-delta` / `-end` | tool call 流式片段 |
| `agent/tool-start` | 有效 call |
| `agent/tool-end` | call + result |
| `agent/tool-rejected` | call + result + reason |

`ToolRejectedReason = "blocked" | "invalid" | "unknown" | "aborted"`。事实事件只报告已经发生
或正在发生的运行事实，观察者返回值被忽略。

## Tools

### 用法

```ts
import { Type, type Static } from "typebox";
import {
  AgentTool,
  AgentToolRegistry,
  type AgentToolResult,
} from "./index.js";

const parameters = Type.Object({ text: Type.String() });

class EchoTool extends AgentTool<typeof parameters> {
  constructor() {
    super("echo", "Return text.", parameters);
  }

  async execute(
    args: Static<typeof parameters>,
    _signal: AbortSignal,
  ): Promise<AgentToolResult> {
    return { content: args.text, isError: false };
  }
}

const tools = new AgentToolRegistry();
tools.register(new EchoTool());
```

### 接口

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
  prepare(call: AgentToolCall): ToolPreparation;
  execute(prepared: PreparedAgentToolCall, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}
```

Registry 拆成两阶段：`prepare(call)` 返回 `ready`（携带 `prepared`）或 `rejected`
（携带 `reason: "unknown" | "invalid"` 与 synthetic result）。`execute(prepared)` 只负责
timeout 和异常归一化，不重复 lookup 或 validate。`ToolPreparation` 与
`PreparedAgentToolCall` 是模块内部类型，不从公开入口导出。

## AgentHarness

位于 sibling 包 `harness/`。持有 `_messages`、管理 `activeRun`、构造 `AgentRunIdentity`，
并通过共享的 `Events` 调用 `runAgentLoop()`。

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  get sessionId(): string;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}
```

详见 [harness/README.md](../harness/README.md)。

## 完整公开导出

从 `src/agent/events.ts`：
- `AgentRunIdentity`, `ToolCallDecision`, `ToolRejectedReason`

从 `src/agent/tools/index.ts`：
- `AgentTool`, `AgentToolRegistry`
- `AgentToolCall`, `AgentToolResult`

从 `src/agent/types.ts`（经根入口）：
- `AgentContext`, `AgentLoopConfig`, `AgentMessage`

agent 的事件契约与 `Events` 分发器共同构成控制与观察通道；本包不导出任何 listener 注册表。

## 与 UI 的解耦

agent 层（以及其上的 coding-agent 层）从不 import 任何 UI/CLI 类型。UI 通过两种**不同**
的机制注入，二者都遵循依赖倒置（DI）：

### 控制事件：闭包捕获

Permission 等控制 listener 注册在共享 `Events` 上并闭包捕获 `CodingAgentInteractions`；
agent 的 generic dispatcher 不打开任何 context 盒子，listener 自己持有依赖。

### Tool：构造注入（没有 context）

`AgentTool.execute(args, timeoutSignal)` **没有** context/UI 参数。工具由 coding-agent 的
具体 `CodingToolDefinition` 在 `createProject()` 中经包内翻译成为 `AgentTool`；组合根捕获依赖。

### 关键原则：交互策略属于控制事件，安全底线由工具再次保证

「用户确认」这类 UI 交互不是工具职责，而是**策略**职责。Permission listener 在工具执行前
执行 allow/ask 策略，也拒绝 hard-deny 命令；Bash Tool 自身再次检查 hard-deny，形成纵深防御。
工具执行机制不负责询问用户。

## 包边界

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
