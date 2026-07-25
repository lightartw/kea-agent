# agent

`agent` 在 `ai.StreamFn` 之上实现多 turn 工具循环。

一次 `AgentHarness.prompt()` 是一个 agent run；每次调用 LLM 是一个 turn。assistant
有 tool call 时，agent 顺序执行工具、保存结果并开始下一 turn；没有 tool call 时结束。

agent 核心分为四部分：

1. `runAgentLoop`：纯函数，多 turn 事件循环。
2. `HookRegistry`：统一 hook 注册与分发。
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

1. `agent_start`，通过 `config.hooks.trigger("user_prompt")` 检查拦截。
2. 写入 user message。
3. 每个 turn 执行 `hooks.trigger("pre_turn")`，通过 `hooks.trigger("context")` 变换上下文。
4. 用 `convertToLlm` 构造 ai `Context`，消费 `StreamFn`。
5. 产生 `turn_end`，执行 `hooks.trigger("turn_end")`。
6. 无 tool call 时结束；有 tool call 时每个工具执行前触发 `hooks.trigger("tool_call")`（可 block），执行后触发 `hooks.trigger("tool_result")`。
7. 结束时产生 `agent_end`。

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
  readonly hooks: HookRegistry;
}
```

`hooks` 统一了所有生命周期回调。loop 只调 `trigger()`，不关心 reducer 语义。

## HookRegistry

位于 `agent/hooks/`。

```ts
class HookRegistry {
  constructor(reducers?: Record<string, ReduceStrategy>);

  register(type: string, handler: (event: unknown) => Promise<unknown>): () => void;
  trigger(type: string, event: unknown): Promise<unknown>;
}
```

四种 reducer 策略：

| 策略 | 行为 |
|------|------|
| `earlyExit` | 串行，任一 handler 返回非 undefined 立即停止 |
| `transform` | 串行，下个 handler 看到上一个的输出 |
| `patch` | 串行，补丁累积合并 |
| `observe` | 串行，全部执行，忽略返回值 |

默认事件：

| 事件 | reducer | loop 中的位置 |
|------|---------|-------------|
| `user_prompt` | `earlyExit` | 写入 user message 前 |
| `pre_turn` | `observe` | 每次 LLM 调用前 |
| `context` | `transform` | `pre_turn` 之后，LLM 调用前 |
| `tool_call` | `earlyExit` | 工具执行前 |
| `tool_result` | `patch` | 工具执行后 |
| `turn_end` | `observe` | 每个 turn 结束时 |

handler 抛异常会中断链并穿透到 `trigger()` 调用方（`tool_call` 的异常被 loop 捕获并转为 block，安全默认）。

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

位于 `agent/harness/`。持有 `_messages`、管理 `activeRun`、直接调用 `runAgentLoop()`、通过 `createLoopConfig()` 注入 `HookRegistry`。

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
