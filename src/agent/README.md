# agent

`agent` 在 `ai.StreamFn` 之上实现多 turn 工具循环。

一次 `runAgentLoop()` 调用是一个 agent run；每次调用 LLM 是一个 turn。assistant
有 tool call 时，Agent 顺序执行工具、保存结果并开始下一 turn；没有 tool call 时结束。Harness 可以在一次 Harness run 中驱动一次或多次 Agent run，但这属于上层语义。

agent 包分为三部分：

1. `runAgentLoop`：纯函数，多 turn 事件循环。
2. `HookRegistry`：类型化 Hook 注册与分发（控制通道）。
3. `AgentTool` 与 `AgentToolRegistry`：工具定义、校验和执行。

有状态的 `AgentHarness` 属于同级 `harness` 包，不是 agent 包的第四部分（见 [harness/README.md](../harness/README.md)）。

## runAgentLoop

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent>;

interface AgentContext {
  readonly systemPrompt: string;
  messages: AgentMessage[];
  readonly tools: AgentToolRegistry;
}
```

不持有实例状态，但会原地修改 `context.messages`。

执行顺序：

1. `agent_start`，通过 `config.hooks.trigger({ type: "user_prompt" })` 检查拦截。
2. 未被拦截则写入 user message。
3. 每个 turn 复制历史消息，通过 `hooks.trigger({ type: "context" })` 变换本次请求上下文。
4. 用 `convertToLlm` 构造 ai `Context`，消费 `StreamFn`。
5. 无 tool call 时触发 `hooks.trigger({ type: "stop" })`，`continueWith` 非空时添加消息并开始下一 turn。
6. 有 tool call 时逐个处理（见下方生命周期）。
7. AI 错误和 Abort 不触发 `stop`；结束时产生 `agent_end`。

### 工具调用生命周期

每个来自最终 assistant message 的 `AgentToolCall` 恰好产生一个终态：

```text
BeforeToolCall -> prepare -> tool_start -> execute -> AfterToolCall
               -> ToolResultMessage -> tool_end

BeforeToolCall/prepare 被拒绝 -> ToolResultMessage -> tool_rejected
```

细节：

- 原始 call 的 `arguments` 先 `structuredClone` 成工作副本，再交给 `BeforeToolCall`
  修改，保证 `tool_rejected.call.arguments` 始终是模型原始对象。
- `prepare()` 完成 lookup 和最终参数验证；只有 `ready` 才发射 `tool_start` 并执行。
- 被 block、参数无效、工具不存在或已 Abort 的调用，合成一条 synthetic
  `ToolResultMessage` 并发射恰好一个 `tool_rejected`，不会静默丢失。
- 批处理中途 Abort 时，已开始的调用照常 `tool_end`，其余调用各得一个 `aborted`
  的 `tool_rejected`。
- 只修改 `details` 的 `AfterToolCall` patch 必须同时返回完整 `content`（Registry 运行时校验）。

### Message 与 Event

```ts
type AgentMessage = Message;

type ToolRejectedReason = "blocked" | "invalid" | "unknown" | "aborted";

interface ToolRejectedEvent {
  readonly type: "tool_rejected";
  readonly call: AgentToolCall;                          // 模型原始请求
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult;
  readonly reason: ToolRejectedReason;
}

type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: readonly AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argumentsDelta: string }
  | { type: "toolcall_end"; toolCall: AgentToolCall }
  | { type: "tool_start"; call: AgentToolCall }
  | { type: "tool_end"; call: AgentToolCall; result: AgentToolResult }
  | ToolRejectedEvent;
```

`tool_start` / `tool_end` 携带 Hook 处理后的有效 `AgentToolCall`；`tool_rejected.call`
始终携带未经改写的模型原始 call，Hook 后的参数放在 `effectiveArguments`。

## AgentLoopConfig

```ts
interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  readonly hooks: AgentHookTrigger;
}
```

`hooks` 是窄触发接口，Loop 只调 `trigger()`，不能注册 Handler 或做生命周期管理。

## 两条运行通道

### `AgentEvent` 与 `subscribe`：观察通道

`AgentEvent` 描述已经发生或正在发生的运行事实。Harness 把每个 `AgentEvent` 提升为
`HarnessEvent`（附 `lane` 与 `runId`），并通过 `subscribe` 交付给 UI 或其他消费者。

观察者的返回值被忽略。它不能阻止工具执行、改写上下文、修改工具结果或要求 Agent 继续运行。

### Hook：控制通道

Hook 在状态或动作提交前被调用，可以根据调用契约阻止、转换、修补或续跑。两者虽然都由回调实现，但权限、调用时机和返回值契约完全不同。

## HookRegistry

位于 `agent/hooks/`。类型化、支持生命周期管理。没有 passive listener/observer——只观察不控制执行的需求统一走 Harness `subscribe`。

### 五种 Agent Hook Call

| Call | 类型 | 组合规则 |
|------|------|---------|
| `user_prompt` | `BeforeUserPromptCall` | 顺序执行；第一个 `block: true` 获胜并提前结束 |
| `context` | `TransformContextCall` | 顺序应用 `messages`；后一个看到前一个结果；只影响本次请求 |
| `tool_call` | `BeforeToolCall` | 顺序执行与共享可变 `input`；第一个 `block: true` 获胜 |
| `tool_result` | `AfterToolCall` | 顺序应用 patch；后一个看到前一个结果 |
| `stop` | `BeforeStopCall` | 第一个 `continueWith` 获胜并提前结束 |

### 公开 API

```ts
export class HookRegistry<TContext> {
  constructor(context: TContext);
  get context(): TContext;
  setContext(context: TContext): void;

  register<TType extends AgentHookCall["type"]>(
    type: TType,
    handler: HookHandler<Extract<AgentHookCall, { type: TType }>, TContext>,
  ): Unregister;

  trigger<T extends AgentHookCall>(
    call: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined>;

  addCleanup(cleanup: Cleanup): Unregister;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}
```

### 语义

- Handler 按注册顺序执行。
- 每次 `trigger` 开始时快照 context 和该 Call 的 Handler 列表。
- 触发期间的注册/注销只影响下一次 `trigger`。
- `Unregister` 幂等；`clear` 逆序执行 Cleanup 后可复用；`dispose` 永久销毁。
- Handler 错误原样穿透，不包装。

### `AfterToolCall` patch 不变量

`AfterToolCallPatch` 是联合类型：只改 `content`/`isError` 允许省略 `details`；但一旦
patch 带 `details` 自有属性，就必须同时带字符串 `content`。Registry 在应用每个 Handler
输出前运行时校验，违规按 AfterToolCall 异常策略处理。

## AgentHookTrigger

```ts
interface AgentHookTrigger {
  trigger<TCall extends AgentHookCall>(
    call: TCall,
    signal?: AbortSignal,
  ): Promise<ResultOf<TCall> | undefined>;
}
```

Agent Loop 和 Harness 只依赖此接口，不看到 `register()`、context 或 lifecycle。

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

位于 sibling 包 `harness/`。持有 `_messages`、管理 `activeRun`、直接调用 `runAgentLoop()`、通过 `createLoopConfig()` 注入 `AgentHookTrigger`。

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  subscribe(listener: HarnessListener): Unsubscribe;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}
```

详见 [harness/README.md](../harness/README.md)。

## 完整公开导出

从 `src/agent/hooks/index.ts`：
- `HookRegistry`
- `AgentHookCall`, `AgentHookTrigger`
- `HookHandler`, `ResultOf`
- `Unregister`, `Cleanup`
- `BeforeUserPromptCall`, `BeforeUserPromptResult`
- `TransformContextCall`, `TransformContextResult`
- `BeforeToolCall`, `BeforeToolCallResult`
- `AfterToolCall`, `AfterToolCallPatch`
- `BeforeStopCall`, `BeforeStopResult`

从 `src/agent/tools/index.ts`：
- `AgentTool`, `AgentToolRegistry`
- `AgentToolCall`, `AgentToolResult`

从 `src/agent/types.ts`（经根入口）：
- `AgentEvent`, `AgentContext`, `AgentLoopConfig`, `AgentMessage`
- `ToolRejectedEvent`, `ToolRejectedReason`

从 `src/harness/index.ts`：
- `AgentHarness`, `Session`, `SessionError`, `SessionManager`
- `defaultSystemPrompt`, `formatSystemPrompt`
- `HarnessConfig`, `HarnessListener`, `HarnessProject`
- `SystemPromptBuilder`, `SystemPromptContext`, `Unsubscribe`
- `SessionContext`, `SessionErrorCode`

## 与 UI 的解耦

agent 层（以及其上的 coding-agent 层）从不 import 任何 UI/CLI 类型。UI 通过两种**不同**的机制注入，二者都遵循依赖倒置（DI）：

### Hook：`TContext` 泛型盒子

`HookRegistry<TContext>` 是泛型——agent 的 hook 层只负责把不透明的 `TContext` 原样传给 handler，它**不知道**盒子里装了什么。

- coding-agent 定义 `CodingHookContext = { cwd, interactions }`，把 `interactions`（一个 `CodingAgentInteractions`）塞进 context。
- 需要和用户交互的 hook（如 permission）从 `context.interactions` 取出 `confirm`/`notify` 调用。
- UI 实现 `CodingAgentInteractions`；coding-agent 永不 import UI。

### Tool：构造注入（没有 context）

`AgentTool.execute(args, timeoutSignal)` **没有** context/UI 参数。工具由 coding-agent 的
`createDefaultToolDefinitions()` 定义，经 `toAgentTool()` 投影为 `AgentTool`；组合根捕获依赖。

### 关键原则：策略属于 Hook，不属于工具

「用户确认」这类 UI 交互不是工具职责，而是**策略**职责。Permission Hook（持有 `context.interactions`）在工具执行前 gate bash 命令（allow/ask/deny），工具本身保持纯函数。这是策略与机制分离——工具是机制，Hook 是策略。

## 包边界

agent 只从相邻 ai 层直接依赖：

| ai 接口 | agent 用途 |
|---------|-----------|
| `StreamFn` | 注入 LLM 能力 |
| `ModelConfig` | model/provider 选择 |
| `Message` | `AgentMessage` 和转换结果 |
| `Context` | 调用 LLM 前临时构造 |
| `AssistantMessageEvent` | loop 消费 ai stream |
| `Tool` | `AgentTool` schema 契约 |

其他依赖：

- `typebox`、`typebox/compile`：工具参数类型和校验；
- `utils/timeout`：工具 timeout；
- 不依赖 coding-agent、UI 或具体工具实现。
