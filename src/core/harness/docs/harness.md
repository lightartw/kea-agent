# Harness：AgentHarness 运行器

`AgentHarness` 是 session-bound 的组合根：它把 `runAgentLoop()`（loop 能力）、`AgentTool` 的
`AgentToolRegistry`（tool 能力）和 `Session`（session 能力）绑成一份 Session 的运行器，并持有
调用方注入的观察事件总线 `HarnessEventBus` 与控制钩子 `HarnessHooks`。loop、tool、事件与钩子
契约的细节见 [agent.md](./agent.md)；Session 的模型、Repository 与持久化见 [session.md](./session.md)；
本包对外的基本使用方式见 [README.md](../README.md)。

## AgentHarness

`AgentHarness` 是一个有状态的单 Session 运行器。它持有 Session、当前模型、Tool Registry、正在
运行的 Run，以及一个 `HarnessEventBus` 和一个 `HarnessHooks`；它不创建或查找 Session，这些工作
属于 `SessionRepository`，也不创建事件总线或钩子——这些由调用方创建后注入。

### 构造与恢复

构造函数接收以下依赖：

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: HarnessEventBus;   // 观察事件总线，调用方创建
  readonly hooks: HarnessHooks;       // 控制钩子，调用方创建并预注册
}
```

- `session` 提供历史并接收新增消息和模型变更；Session 已保存的模型优先于 `modelConfig`；
- `runtime` 提供 provider 路由和对指定 provider/model 的 LLM 请求；它不保存当前模型；
- `modelConfig` 是 Session 没有保存模型时的初始 `ModelConfig`；
- `toolRegistry` 提供本次 Agent 可以看见和执行的 Tool；
- `systemPrompt` 是直接交给 Agent 的最终字符串；
- `events` 是观察事件总线，Harness 把 Run 边界与事实发布到它上面，listener 经 `subscribe()`
  观察；
- `hooks` 是控制钩子，`beforePrompt`/`transformContext`/`beforeTool` 由调用方预注册（如
  coding-agent 的权限作为 `beforeTool`）。

构造时，如果 Session 中保存过模型选择，Harness 从 Session 恢复模型，否则使用配置中的
`modelConfig`。消息仍由 Session 持有，Harness 在每次 `prompt()` 开始时取得当前路径的消息。
构造后 `currentModel` 是运行时的权威模型；`model_selection` 是 Session 的持久记录，用于恢复
这项权威状态，`ModelRuntime` 永远不拥有它。

### `prompt()`：一次完整的 Run

一次 `prompt()` 对应一次 `runAgentLoop()`，不等于一次 `runtime.stream()` 调用。模型可能先请求 Tool，
再根据 Tool Result 继续请求模型，因此一次 Run 内可以发生多次 LLM 请求。

`prompt(input)` 的执行顺序如下：

1. 创建本次 Run 的 `AbortController` 和 `{ sessionId, runId }`；
2. 在自持总线上发布 `run-start`；
3. 构造一个 `AgentContext`（含 Run 身份、消息、system prompt、Tools、观察总线 `events`、控制
   钩子 `hooks` 与取消信号），从 `runtime.stream` 绑定出 `StreamFn`，调用一次 `runAgentLoop()`；
   完整 `ModelRuntime` 不进入 Agent Loop；
4. Agent 产生完整消息时，`appendMessage` 先调用 `session.append()` 持久化，成功后才把消息加入
   本次 Run 的消息数组；首条 user message 持久化后，Harness 先尝试生成并保存 Session 标题，再
   开始主模型 Turn；
5. Agent 完成、中止或失败后，Harness 先清理运行状态，再发布一个对应的 `run-end`；
6. 如果是运行失败，在发布 `run-end` 后把原错误重新抛给调用方。

这里最重要的边界是：`AgentHarness` 负责一次 Run 的身份、状态和收尾，Run 内部如何多轮请求模型、
执行 Tool，仍由 `runAgentLoop()` 负责。

### 运行状态与中止

同一个 `AgentHarness` 同时只允许一个 `prompt()`。运行期间再次调用 `prompt()`、
`switchModel()`、`registerTool()` 或 `unregisterTool()`，会抛出 `AgentHarness is busy`，避免正在
运行的 Agent 看到中途变化的模型或 Tools。

`abort()` 在空闲时没有效果；运行时，它请求中止当前 Run。只有 AbortSignal 的 `reason` 或
`AbortError` 被当作正常中止。即使已经请求中止，同时发生的存储错误或其他系统错误仍属于
`error`，不会被取消信号掩盖。发布 `run-end` 时，`isRunning` 已经恢复为 `false`。

### 模型、Tools 与标题

`switchModel()` 先把模型选择写入 Session，成功后才更新 Harness 的当前模型。`registerTool()`
和 `unregisterTool()` 修改传入的 Tool Registry；新的 Tools 从下一次 Run 开始进入 Agent 上下文。
`setTitle()` 直接写入 Session，不受 busy 状态限制。

新 Session 的首条实际 user message 持久化后，Harness 使用当前模型调用一次
`ModelRuntime.complete()` 生成标题。这里使用的是经过 `beforePrompt` 钩子修改后的文本；标题请求
不携带 Tools，也不进入 Agent Loop。请求串行完成后才开始正常 Turn，因此当前实现没有后台任务、
并发写入或额外事件。

标题逻辑集中在 `session-title.ts` 的一个函数中：它从第一条非空 user message 生成标题；模型失败
或为空时回退到截取该 prompt 文本，保证标题不会停留在默认值。标题作为 Session 的 header 字段保存，
由 `setTitle` 原地重写，而不是追加一条记录。

### `AgentHarness` 的公开成员

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  setTitle(title: string): Promise<void>;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  get hooks(): HarnessHooks;
  get sessionId(): string;
  get title(): string;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}
```

`messages` 返回 Session 当前路径的消息快照，`model` 是当前模型，`isRunning` 表示一个 Run 是否正在
执行。`subscribe(listener)` 把自持总线上的 `HarnessEvent` 直接转交给 listener（每个 Harness 绑定
一份 Session，无需按 `sessionId` 过滤），返回的取消函数幂等；`hooks` 暴露控制钩子注册面，
调用方可在构造后补注册钩子（正常在创建 `HarnessHooks` 时预注册）。

### System Prompt

`AgentHarness` 调用 `runAgentLoop()` 时必须构造 `AgentContext`，而 `AgentContext` 包含
system prompt，因此 `HarnessConfig` 需要接收这个值。它是 Run 的配置，不是会话历史，不写入
Session。

Harness 接收的是最终字符串，不生成、不格式化也不修改它；同一份 Harness 的每次 Run 都使用
这个字符串。切换模型或增删 Tools 不会重建 system prompt。

Harness 也不需要单独接收 `cwd`。Coding Agent 创建 Harness 时读取
`session.metadata.cwd`，把 system prompt 模板中的 `{{cwd}}` 和 `{{date}}` 替换成当时的值，
再传入最终字符串。这样 Session 是 cwd 的唯一来源，模板规则留在 Coding Agent，Harness 只负责
传递结果。若以后出现明确的动态生成需求，再增量扩展这个边界。

## Session

`AgentHarness` 使用 `Session`/`SessionRepository` 提供会话数据与持久化。Session 的节点模型、
Repository 生命周期与 JSONL 持久化是独立的 session 能力，详见 [session.md](./session.md)。
