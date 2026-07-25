# AgentHarness 重写 + HookRegistry 设计

**目标：** 删除 Agent 中间层，AgentHarness 直接调用 `runAgentLoop()`；新增 `HookRegistry` 统一 hook 注册与分发，为 permission 管线提供脚手架。

## 1. 架构变更

```
之前:
  AgentHarness → Agent.prompt() → runAgentLoop()

之后:
  AgentHarness → createLoopConfig() → runAgentLoop()
                   └── { model, convertToLlm, hooks: HookRegistry }
```

AgentHarness 吸收 Agent 的所有职责：messages 持有、activeRun 管理、abortController 管理、直接调用 runAgentLoop。

## 2. 文件变更

### 新增

- `src/agent/hooks/registry.ts` — HookRegistry 类
- `src/agent/hooks/types.ts` — HookEvent 接口、reducer 策略类型
- `tests/agent/hooks/registry.test.ts` — HookRegistry 测试

### 删除

- `src/agent/agent.ts`
- `tests/agent/agent.test.ts`

### 修改

- `src/agent/agent-loop.ts` — 回调槽位替换为 `config.hooks.trigger()`
- `src/agent/types.ts` — AgentLoopConfig 精简为 `{ model, convertToLlm, hooks }`
- `src/harness/agent-harness.ts` — 吸收 Agent 职责，直接调用 runAgentLoop
- `src/agent/tools/index.ts` — 移除 Agent/AgentState 相关导出（如有）
- `src/agent/index.ts` — 若有则更新
- `src/harness/factory.ts` — 移除 Agent 相关引用
- `tests/harness/agent-harness.test.ts` — 适配新 API

## 3. HookRegistry

### 文件：`src/agent/hooks/registry.ts`

```ts
type ReduceStrategy = "earlyExit" | "transform" | "patch" | "observe";

const DEFAULT_REDUCERS: Record<string, ReduceStrategy> = {
  tool_call:   "earlyExit",
  context:     "transform",
  tool_result: "patch",
  turn_end:    "observe",
  user_prompt: "earlyExit",
  pre_turn:    "observe",
};

class HookRegistry {
  constructor(reducers?: Record<string, ReduceStrategy>);  // 覆盖默认值

  register(type: string, handler: (event: any) => Promise<any>): () => void;
  trigger(type: string, event: unknown): Promise<unknown>;
}
```

### Reducer 行为

| 策略 | 执行方式 | 返回值 |
|------|---------|--------|
| `earlyExit` | 串行，任一 handler 返回非 undefined → 立即停止 | 该 handler 的返回值 |
| `transform` | 串行，下个 handler 的 input 是上个的 output | 最后一个 handler 的返回值 |
| `patch` | 串行，返回的 patch 浅合并到累积值 | 累积后的 patch |
| `observe` | 串行，全部执行 | 永远 `undefined` |

### handler 异常

handler 抛异常 → 中断链 → 异常穿透到 `trigger()` 调用方，**不包装**（和 pi 的 `AgentHarnessError` 包装不同）。

### 注册顺序

handlers 用 `Map<string, Set<Handler>>` 存储，同事件多个 handler 按 `register()` 调用顺序执行。

## 4. AgentLoopConfig

```ts
interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  readonly hooks: HookRegistry;
}
```

删除的字段：`onUserPrompt`、`onPreTurn`、`onBeforeTool`、`onAfterTool`、`onStop`。

## 5. agent-loop 事件触发点

```
runAgentLoop(input, context, config, streamFn, signal)

yield agent_start
  → config.hooks.trigger("user_prompt", { prompt: input })   // earlyExit
  → 若返回 { block } → agent_end 并 return

context.messages.push(userMessage)

while true:
  → config.hooks.trigger("pre_turn")      // observe

  → config.hooks.trigger("context", { messages })  // transform
  → 若返回 { messages } → context.messages = messages

  stream LLM...
  → assistant message 入队

  yield turn_end
  → config.hooks.trigger("turn_end", { message })  // observe

  若无 tool calls:
    yield agent_end
    return

  有 tool calls:
    for each call:
      yield tool_start
      → config.hooks.trigger("tool_call", { toolCallId, toolName, input })  // earlyExit
      → 若返回 { block } → error result，跳过执行

      execute tool

      yield tool_end
      → config.hooks.trigger("tool_result", { toolCallId, toolName, input, content, isError })  // patch
```

## 6. AgentHarness 重写

AgentHarness 吸收原 Agent 的职责：

```ts
class AgentHarness {
  private messages: AgentMessage[];         // 原 agent.history
  private activeRun: ActiveRun | undefined;  // 原 Agent 的 activeRun
  private hooks: HookRegistry;               // 新增

  constructor(config: HarnessConfig);

  // 直接调 runAgentLoop
  private async *runPrompt(input: string): AsyncIterable<AgentEvent>;

  async prompt(input: string): Promise<void>;  // 不变
  subscribe(listener): () => void;              // 不变
  abort(): void;                                // 自己管理 abortController
  switchModel(model): Promise<void>;            // 不变
  registerTool(tool): void;                     // 不变
  unregisterTool(name: string): void;           // 不变
  get messages(): readonly AgentMessage[];      // 返回 this.messages
  get model(): ModelConfig;                     // 不变
  get isRunning(): boolean;                     // 自己判断
}
```

### `prompt()` 流程

```ts
async prompt(input: string): Promise<void> {
  this.assertIdle();
  this.running = true;
  this.abortRequested = false;

  try {
    await this.prepareAgentForRun();

    for await (const event of this.runPrompt(input)) {
      await this.persistNewMessages();
      await this.publish(event);
    }
  } finally {
    try { await this.persistNewMessages(); }
    finally { this.running = false; }
  }
}
```

### `runPrompt()` — 替代原 `Agent.prompt()`

```ts
private async *runPrompt(input: string): AsyncIterable<AgentEvent> {
  const abortController = new AbortController();
  this.activeRun = { abortController };

  const config: AgentLoopConfig = {
    model: this.currentModel,
    convertToLlm: (msgs) => msgs as Message[],
    hooks: this.hooks,
  };

  try {
    for await (const event of runAgentLoop(
      input,
      { systemPrompt: this.agentSystemPrompt, messages: this.messages, tools: this.toolRegistry },
      config,
      this.streamFn,
      abortController.signal,
    )) {
      yield event;
    }
  } finally {
    this.activeRun = undefined;
  }
}
```

### `HarnessConfig` 变更

新增字段：
```ts
interface HarnessConfig {
  // ... 原有字段 ...
  readonly hooks?: HookRegistry;  // 可选，默认 new HookRegistry()
}
```

## 7. Permission 脚手架

permission 模块不在此 spec 范围，但 HookRegistry 为其预留了足够空间。Permission 将作为独立的 `PermissionPipeline` 模块实现，通过以下方式接入 AgentHarness：

```ts
// 未来使用方式
const harness = await createHarness({ ... });
harness.hooks.register("tool_call", permissionPipeline.handler());
```

本次 spec 只实现 HookRegistry + AgentHarness 重写。permission 的 CLI 交互（闸门 3）需要 `readline` 能力，将在后续实现。

## 8. 测试

### HookRegistry 测试 (`tests/agent/hooks/registry.test.ts`)

- `earlyExit` reducer: 第一个 handler block 后不再执行后续
- `earlyExit` reducer: 全部放行返回 undefined
- `transform` reducer: 链式变换，下个 handler 收到上个人的输出
- `patch` reducer: 补丁累积合并
- `observe` reducer: 返回值被忽略
- 同事件多 handler 按注册顺序执行
- `register()` 返回取消注册函数
- handler 抛异常穿透
- 自定义 reducer 覆盖默认

### AgentHarness 测试适配

- 更新 `tests/harness/agent-harness.test.ts` — 由于 AgentHarness API 不变（`prompt()`、`subscribe()`、`abort()` 等签名保持），现有测试应该基本兼容

## 9. 删除确认

- `src/agent/agent.ts` — Agent 类
- `tests/agent/agent.test.ts` — Agent 测试（共 2 项：`Agent owns conversation history across prompts`、`Agent exposes tool failures through state.errorMessage`）

Agent 测试中的"跨 prompt 持有历史"行为由 AgentHarness 的 `persistNewMessages` + `messages` getter 覆盖。"tool failures through state.errorMessage" 行为已废弃（旧 API）。

## 10. 非目标

- 不实现 permission 模块本身
- 不添加 compaction、tree navigation、skills、prompt templates
- 不添加 `AgentHarnessError` 包装（handler 异常直接穿透）
- 不修改 `AgentEvent` 类型
