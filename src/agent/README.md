# agent

Agent 内核。有状态包装器 + 纯函数循环 + 通用 tool/hook 基础设施。

不知道任何具体工具（bash、files）或展示层（CLI、TUI）。

## Agent

### `Agent` — [agent.ts](agent.ts)

有状态包装器。持有对话历史。streamFn、model、systemPrompt 可被 harness 跨 turn 修改。

```ts
import { Agent } from "./agent/agent.js";

const agent = new Agent(streamFn, model, registry, [], "You are helpful.", hooks);

agent.state         // AgentState
agent.messages      // readonly Message[]
agent.isRunning     // boolean

// 可变配置（harness 跨 turn 修改）
agent.streamFn      // StreamFn
agent.model         // ModelConfig
agent.systemPrompt  // string

agent.prompt("hi")  // AsyncIterable<AgentEvent>
agent.abort()       // 取消当前 run
agent.reset()       // abort + 清空历史
```

`prompt()` 不处理 hook——全部交给 `runAgentLoop`，只从 `agent_end` 同步 error state。

### `runAgentLoop` — [agent-loop.ts](agent-loop.ts)

纯 async generator。原地修改 `messages`。管理全部 5 个 hook 生命周期。可不依赖 Agent 直接测试。

```ts
import { runAgentLoop } from "./agent/agent-loop.js";

async function* runAgentLoop(
  messages: Message[],         // 原地修改
  systemPrompt: string,
  input: string,               // 用户原始输入——loop 负责推入 user message
  streamFn: StreamFn,
  model: ModelConfig,
  registry: ToolRegistry,
  hooks?: HookRegistry,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent>
```

生命周期：

```text
agent_start
  → user_prompt_submit hook（可 block；异常视为 block）
  → 推入 user message
  → turn_start
  → pre_turn hook（可注入 context 作 user message；异常被 swallow）
  → stream LLM
  → turn_end
  → [pre_tool_use → execute → post_tool_use]*  （每个 tool call）
  → [stop hook]  （无 tool call 时；异常被 swallow）
  → loop back if more tool calls / forceContinue
agent_end
```

### `AgentEvent` — [types.ts](types.ts)

11 种 discriminated event。无可选字段。

```ts
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end";      messages: readonly Message[] }
  | { type: "turn_start" }
  | { type: "turn_end";       message: AssistantMessage }
  | { type: "text_delta";     text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argumentsDelta: string }
  | { type: "toolcall_end";   toolCall: ToolCall }
  | { type: "tool_start";     call: ToolCall }
  | { type: "tool_end";       call: ToolCall; result: ToolResult }
```

### `AgentState` — [types.ts](types.ts)

```ts
interface AgentState {
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
```

## Tool

### `AgentTool<T>` — [tools/types.ts](tools/types.ts)

抽象基类。实现 ai 层的 `Tool`，增加 `validate()` 和 `execute()`。

```ts
abstract class AgentTool<T extends TObject = TObject> implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: T;
  validate(args: unknown): string | undefined;                    // TypeBox 校验
  abstract execute(args: Static<T>, signal: AbortSignal): Promise<string>;
}
```

### `ToolRegistry` — [tools/registry.ts](tools/registry.ts)

验证并执行 tool call。不知道 hook。

```ts
class ToolRegistry {
  constructor(timeout?: number);
  register(tool: AgentTool): void;
  unregister(name: string): void;
  schemas(): Tool[];          // LLM-facing 的 schema
  all(): AgentTool[];         // 完整 AgentTool 实例
  execute(call: ToolCall): Promise<ToolResult>;
}
```

流程：resolve tool → validate arguments → run with timeout → return result。
`pre_tool_use` / `post_tool_use` 由 `runAgentLoop` 触发，不在 registry 内。

## Hook

### Hook 系统 — [hooks/](hooks/)

5 个生命周期事件。全部在 `runAgentLoop` 内触发。链式语义：第一个非 void 返回值停止链。

```ts
type HookEventUnion =
  | UserPromptSubmitEvent   // { type: "user_prompt_submit", prompt }
  | PreTurnEvent            // { type: "pre_turn" }
  | PreToolUseEvent         // { type: "pre_tool_use", call }
  | PostToolUseEvent        // { type: "post_tool_use", call, result }
  | StopEvent               // { type: "stop", messages }
```

### `HookResult` — [hooks/types.ts](hooks/types.ts)

```ts
interface HookResult {
  block?: boolean;          // 拒绝（user_prompt_submit, pre_tool_use）
  reason?: string;
  messages?: readonly Message[];  // 替换历史（stop）
  context?: string;         // 注入为 user message（pre_turn）
  forceContinue?: string;   // 推入 user message 并继续循环（stop）
}
```

### `Hook<TEvent>` — [hooks/types.ts](hooks/types.ts)

```ts
interface Hook<TEvent extends HookEvent = HookEvent> {
  name: string;
  eventType: TEvent["type"];
  execute(event: TEvent): HookResult | void | Promise<HookResult | void>;
}
```

### `HookRegistry` — [hooks/registry.ts](hooks/registry.ts)

```ts
class HookRegistry {
  register(hook: Hook): void;
  get<T>(name: string): T | undefined;
  values(): IterableIterator<Hook>;
  trigger<TEvent>(event: TEvent): Promise<HookResult | undefined>;
}
```

## 用法

最小 Agent：

```ts
const agent = new Agent(streamFn, { provider: "anthropic", model: "claude-sonnet-5" }, new ToolRegistry(), [], "You are helpful.");

for await (const event of agent.prompt("What is 2+2?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

带 tool + hook：

```ts
class EchoTool extends AgentTool<typeof Type.Object({ msg: Type.String() })> {
  constructor() { super("echo", "Echo.", Type.Object({ msg: Type.String() })); }
  async execute(args) { return args.msg; }
}

const hooks = new HookRegistry();
hooks.register(new PermissionHook());

const registry = new ToolRegistry();
registry.register(new EchoTool());

const agent = new Agent(stream, { provider: "anthropic", model: "claude-sonnet-5" }, registry, [], "You are helpful.", hooks);
for await (const event of agent.prompt("echo 'hi'")) { /* render */ }
```

直接测试 `runAgentLoop`：

```ts
const history: Message[] = [];
const streamFn: StreamFn = async function* () { yield { type: "done", message }; };

for await (const event of runAgentLoop(history, "", "hi", streamFn, { provider: "t", model: "m" }, new ToolRegistry())) {
  // assert on events
}
```

## 依赖

从 ai 导入：

- **全局数据**：`Message`、`AssistantMessage`、`Tool`、`ToolCall`、`ModelConfig`
- **传输**：`StreamFn`、`Context`

不重导出 ai 类型。消费者直接从 ai 导入 `Tool` 或 `ToolCall`。
