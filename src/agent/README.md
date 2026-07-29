# agent

`agent` 在 `ai.StreamFn` 之上实现多 turn 工具循环。

一次 `AgentHarness.prompt()` 是一个 agent run；每次调用 LLM 是一个 turn。assistant
有 tool call 时，agent 顺序执行工具、保存结果并开始下一 turn；没有 tool call 时结束。

agent 核心分为四部分：

1. `runAgentLoop`：纯函数，多 turn 事件循环。
2. `HookRegistry`：类型化 Hook 注册与分发（控制通道）。
3. `AgentTool` 与 `AgentToolRegistry`：工具定义和执行。
4. `AgentHarness`：有状态运行时的核心类，位于 `harness/` 子目录。

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
6. 有 tool call 时每个工具执行前触发 `hooks.trigger({ type: "tool_call" })`（可 block / 修改 input），执行后触发 `hooks.trigger({ type: "tool_result" })`（可修补结果），最终结果一致用于 `tool_end`、历史与下一次请求。
7. AI 错误和 Abort 不触发 `stop`；结束时产生 `agent_end`。

### Message 与 Event

```ts
type AgentMessage = Message;

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
  | { type: "tool_end"; call: AgentToolCall; result: AgentToolResult };
```

## AgentLoopConfig

```ts
interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  readonly hooks: AgentHookTrigger;
}
```

`hooks` 是窄触发接口，Loop 只调 `trigger()`，不能注册 Handler、Observer 或做生命周期管理。

## 两条运行通道

### `AgentEvent` 与 `subscribe`：观察通道

`AgentEvent` 描述已经发生或正在发生的运行事实。Harness 的 `subscribe` 让 UI 或其他消费者接收这些事件。

观察者的返回值被忽略。它不能阻止工具执行、改写上下文、修改工具结果或要求 Agent 继续运行。

### Hook：控制通道

Hook 在状态或动作提交前被调用，可以根据事件契约阻止、转换、修补或续跑。两者虽然都由回调实现，但权限、调用时机和返回值契约完全不同。

## HookRegistry

位于 `agent/hooks/`。类型化、支持生命周期管理。

### 五种 Agent Hook 事件

| 事件 | 类型 | 组合规则 |
|------|------|---------|
| `user_prompt` | `UserPromptEvent` | 顺序执行；第一个 `block: true` 获胜并提前结束 |
| `context` | `ContextEvent` | 顺序应用 `messages`；后一个看到前一个结果；只影响本次请求 |
| `tool_call` | `ToolCallEvent` | 顺序执行与共享可变 `input`；第一个 `block: true` 获胜 |
| `tool_result` | `ToolResultPatch` | 顺序应用 patch；后一个看到前一个结果 |
| `stop` | `StopEvent` | 第一个 `continueWith` 获胜并提前结束 |

### 公开 API

```ts
export class HookRegistry<TEvent extends HookEvent<string, unknown>, TContext> {
  constructor(context: TContext);
  get context(): TContext;
  setContext(context: TContext): void;

  register<TType extends TEvent["type"]>(
    type: TType,
    handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
  ): Unregister;

  registerObserver(observer: HookObserver<TEvent, TContext>): Unregister;

  trigger<T extends TEvent>(
    event: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined>;

  addCleanup(cleanup: Cleanup): Unregister;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}
```

### 语义

- Handler 按注册顺序执行；Observer 在所有 Handler 前执行。
- Observer 返回值被忽略，不能控制流程。
- 每次 `trigger` 开始时快照 context、Observer 列表和该事件 Handler 列表。
- 触发期间的注册/注销只影响下一次 `trigger`。
- `Unregister` 幂等；`clear` 逆序执行 Cleanup 后可复用；`dispose` 永久销毁。
- Handler / Observer 错误原样穿透，不包装。

## AgentHookTrigger

```ts
interface AgentHookTrigger {
  trigger<TEvent extends AgentHookEvent>(
    event: TEvent,
    signal?: AbortSignal,
  ): Promise<ResultOf<TEvent> | undefined>;
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
interface AgentToolResult { readonly content: string; readonly isError: boolean; }
interface AgentToolCall {
  readonly type: "toolCall"; readonly id: string;
  readonly name: string; readonly arguments: Record<string, unknown>;
}

abstract class AgentTool<TParameters extends TObject = TObject> implements Tool {
  protected constructor(name: string, description: string, parameters: TParameters);
  validate(arguments_: unknown): string | undefined;
  abstract execute(args: Static<TParameters>, timeoutSignal: AbortSignal): Promise<AgentToolResult>;
}

class AgentToolRegistry {
  constructor(timeout?: number);  // 秒，默认 120
  register(tool: AgentTool): void;
  unregister(name: string): void;
  schemas(): Tool[];
  all(): AgentTool[];
  execute(call: AgentToolCall): Promise<AgentToolResult>;
}
```

## AgentHarness

位于 `agent/harness/`。持有 `_messages`、管理 `activeRun`、直接调用 `runAgentLoop()`、通过 `createLoopConfig()` 注入 `AgentHookTrigger`。

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  subscribe(listener: HarnessEventListener): Unsubscribe;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}
```

详见 [harness/README.md](harness/README.md)。

## 完整公开导出

从 `src/agent/hooks/index.ts`：
- `HookRegistry`
- `AgentHookEvent`, `AgentHookTrigger`, `HookEvent`
- `HookHandler`, `HookObserver`, `ResultOf`
- `Unregister`, `Cleanup`
- `UserPromptEvent`, `UserPromptResult`
- `ContextEvent`, `ContextResult`
- `ToolCallEvent`, `ToolCallResult`
- `ToolResultEvent`, `ToolResultPatch`
- `StopEvent`, `StopResult`

从 `src/agent/harness/index.ts`：
- `AgentHarness`, `Session`, `SessionError`, `SessionManager`
- `defaultSystemPrompt`, `formatSystemPrompt`
- `HarnessConfig`, `HarnessEventListener`, `HarnessProject`
- `SystemPromptBuilder`, `SystemPromptContext`, `Unsubscribe`
- `SessionContext`, `SessionErrorCode`

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
- 不依赖 coding-agent、CLI 或具体工具实现。
