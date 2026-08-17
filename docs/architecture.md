# Kea Agent 架构

**更新：** 2026-08-15

本文描述当前代码的所有权与边界。`ai`、`agent`、`events`、`harness` 共同组成
`src/core/` 下的 Harness 核心。依赖方向是
`ui -> coding-agent -> core/harness -> core/agent -> core/ai`；`core/events` 由核心运行时共享，
`main.ts` 是连接具体 UI、Coding Agent 和 AI provider 的组合根。

## 1. AI：LLM 流式协议

`src/core/ai/` 统一 Anthropic、OpenAI 和 Gemini 的流式协议，不保存会话，也不执行工具。

```ts
type StreamFn = (
  model: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<StreamChunk>;

interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}
```

`createStreamFn()` 返回 `stream` 和 `defaultModel`。Provider adapter 在流第一次迭代时动态加载。
`ToolResultMessage.content` 是模型可见文本；`details` 是 Session、Agent 和 UI 使用的结构化数据，
不会被 provider adapter 发到模型服务。

`StreamChunk` 是一次 provider 响应中的一个片段，由 Agent 直接消费；它是数据传输，不是运行事件，
不会注册、发布或通过 `Events` 观察。每一轮 Stream 必须以 `done` 或 `error` 终止块结束；Agent
在缺少终止块时让 Run 失败，不发布没有完整消息的 `agent/turn-end`。

## 2. Events：统一分发器

`src/core/events/` 提供一次 `runAgentLoop()` 或 `prompt()` 期间唯一的运行时事件通道。`EventMap`
是编译期契约：各包通过模块扩充把 event 名、输入和结果加入 `EventMap`；`Events` 是运行时
dispatcher。

```ts
class Events {
  constructor(
    onListenerError?: (
      error: unknown,
      name: string,
      input: unknown,
    ) => void,
  );
  on<TName extends EventName>(
    name: TName,
    listener: ListenerOf<TName>,
  ): () => void;
  emit<TName extends EmitEventName>(name: TName, input: EventInput<TName>): Promise<void>;
  intercept<TName extends InterceptEventName>(
    name: TName,
    input: EventInput<TName>,
    handler: (input: EventInput<TName>) => EventResult<TName> | Promise<EventResult<TName>>,
    signal?: AbortSignal,
  ): Promise<EventResult<TName>>;
}
```

- `emit` 按注册顺序调用全部 listener，逐个隔离异常并交给错误处理器；错误处理器自身失败不会
  改变 event 分发；
- `intercept` 让 listener 按顺序包裹一个最终 `handler`；listener 调用
  `proceed(changedInput)` 把值传给下一个 listener，不调用 `proceed()` 就返回时终止链，每个
  listener 最多调用一次 `proceed()`；
- `intercept` 在分发前、进入每一层前和每个 awaited listener 返回后检查 `AbortSignal`；
  listener 错误原样穿透给行为拥有者；
- 同一函数注册两次是两次独立注册；移除函数幂等；每次分发使用当时的 listener 快照。

emit listener 只有一个输入参数并返回 `void`；intercept listener 有 `(input, proceed, signal?)`
签名。条件辅助类型（`EmitEventName`、`InterceptEventName`、listener、输入和结果推导）只供
`src/core/events/events.ts` 内部实现使用。

每个 event 都携带 `AgentRunIdentity`（`sessionId`、`runId`）。Project 身份来自
`Events` 实例本身，不进入每个 event。

`src/core/events/index.ts` 导出 `Events`、`EventMap`、`EmitEvent` 与 `InterceptEvent`。

## 3. Agent：Tool 循环与事件控制

`src/core/agent/` 用 `runAgentLoop()` 执行一次多 Turn Agent Run。它接收用户输入、
`AgentContext`、`AgentLoopConfig` 与 `StreamFn`，并产生 `Promise<void>`。

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
): Promise<void>;

interface AgentContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolRegistry;
  readonly events: Events;
  readonly signal?: AbortSignal;
  appendMessage(message: AgentMessage): Promise<void>;
}

interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly maxTurns?: number;
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
}
```

### 控制事件

`src/core/agent/events.ts` 声明两个控制拦截器（通过 `EventMap` 扩充）：

| 事件 | 作用 |
| ---- | ---- |
| `agent/user-prompt` | user message 写入前，返回 `undefined` 阻止 Run |
| `agent/context` | 每次 LLM 请求前整理消息快照，不改写 Session 历史 |

控制事件在状态或动作提交前执行，可以改变尚未提交的行为；它不是被动 listener。
Turn 后是否继续由 Agent Loop 内建决定：本轮有 Tool Result 就继续，让模型消费结果；没有则结束。

### 事实事件

Agent 同时声明 `emit` 事实事件：`agent/turn-start`、`agent/turn-end`、
`agent/text-delta`、`agent/thinking-delta`、`agent/tool-call-start`、
`agent/tool-call-delta`、`agent/tool-call`、`agent/tool-result`。完整消息先经
`context.appendMessage()` 提交，再发布对应完成事实。

每个 Tool Call 在 `AgentToolRegistry.execute()` 内先做 lookup 和 TypeBox 校验，再经过三个拦截
阶段，由 `src/core/agent/tools/events.ts` 声明：`tools/pre-execute`、`tools/execute`、
`tools/post-execute`。pre-execute 接收 `ToolCallEvent` 并返回 `allow` 或可选原因的 `deny`；它是
只读决策点，listener 不能替换实际执行的 Tool Call。Registry 把拒绝统一转换成错误结果。execute
接收 `ToolCallEvent` 并运行 Tool 本体；post-execute 接收 `ToolResultEvent`，在结果写入 Session
前修改它。未知、无效、被阻止、已中止或失败的调用都会以恰好一个 `agent/tool-result` 结束。

### Tool 边界

`AgentTool` 定义 schema 和执行，`AgentToolRegistry.execute()` 负责 lookup、验证、三阶段拦截、
timeout 与异常归一化。Agent Tool 不依赖 Coding Agent 或 UI，也不携带展示逻辑。

## 4. Harness：一份 Session 的运行器

`src/core/harness/` 提供 Session 数据、Repository 和 Session 运行能力。

### Session 与 SessionRepository

`Session` 保存消息、模型变更和 Session ID。持久化格式是
`<storageDir>/sessions/<sessionId>.jsonl` 的树形 entry；`buildContext()` 沿当前叶节点的父链恢复
消息和最后选择的模型。

```ts
class SessionRepository {
  constructor(readonly storageDir: string);
  create(): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly string[]>;
}
```

`SessionRepository` 是 Harness 层唯一管理多份 Session 的实体。它在一个 `storageDir` 中创建、
打开和列举 Session；`list()` 通过 `Session.open()` 读取每个候选文件，按存储的 `updatedAt`
从新到旧返回 `SessionInfo[]`。Repository 不创建 Harness，也不保存“当前 Session”。

### AgentHarness

一个 `AgentHarness` 在构造时绑定恰好一份 Session，之后不切换。它公开 `sessionId`，但不暴露
可写 Session 或 Repository。

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

Harness 为这份 Session 持有消息视图、当前模型、Tool Registry、AbortController 和 run 状态。
它构造时接收 Project 提供的共享 `Events`，在 `prompt()` 中创建 Run 身份
（`sessionId`、`runId`），发布 `harness/run-start`，调用一次 `runAgentLoop()`，并发布
`harness/run-end`。同一个 Harness 同时只运行一个 `prompt()`；运行时切换模型或修改 Tool 会抛错。
Harness 没有 `subscribe()`，也没有私有的 EventBus。

### Harness Event 边界

`src/core/harness/events.ts` 把 `harness/run-start`、`harness/run-end` 直接加入
`EventMap`（run-end 的输入内联了 `completed`、`aborted`、`error` 联合）。Listener 观察已经
发生的事实，返回值不会改变运行；`emit` 的 listener 错误被隔离，并交给 `Events` 的错误处理器。

## 5. Coding Agent：Project 级所有者

`src/coding-agent/` 管理持久化 Project，并为每份打开的 Session 建立 coding Harness。

```ts
interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directories: readonly string[];
  readonly primaryDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Project extends ProjectInfo {
  readonly events: Events;
  listSessions(): Promise<readonly SessionInfo[]>;
  createSession(options?: CreateSessionOptions): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  update(input: UpdateProjectInput): Promise<ProjectInfo>;
  renderTool(input: ToolPresentationInput): string;
}

interface CreateProjectConfig {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly systemPrompt?: string;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: (
    error: unknown,
    name: string,
    input: unknown,
  ) => void;
}

function createProject(config: CreateProjectConfig): Promise<Project>;
```

Project 元数据持久化在 `<keaHome>/projects/<id>/project.json`。`createProject()` 先扫描已注册
Project：当启动目录位于某 Project 的 `directories` 之下时复用该 Project（嵌套时选最长）；
否则显式 `directory` 成为新根；否则从 `git rev-parse --show-toplevel` 发现根，失败则回退为
启动 `cwd`。Git 只影响发现；每个非 Git 根目录都有独立 Project 存储。

`Project` 用 `keaHome/projects/<id>` 建立 `SessionRepository`。`continueRecent()` 打开最近的
Session；没有历史时按启动 cwd 创建。Session 方法返回 `AgentHarness`，调用方直接使用它。

`createProject()` 构造**一个** `Events` 实例，并把 Permission 等 coding 控制 listener 注册其上，
再把这个实例作为 `project.events` 传给每个 Harness。因此一份 Project 的全部 Session 共享同一
listener 注册，由 `sessionId` 区分；它们依然拥有独立的可变 Tool、模型和 run 状态。

### Session 与 cwd

一份 Session 存储一个选中的 Project 目录加相对 `cwd`。Coding Agent 给每份 Session 的 Harness
以解析后的绝对 cwd，并把完整 `directories` 交给 Coding Tools；文件 Tool 用
`safePath(cwd, directories, path)` 拒绝离开全部 Project 目录的路径。切换 `primaryDirectory`
只影响之后创建的 Session，不改写已有 Session 文件。

### 默认 Coding 能力

Coding Agent 提供 coding system prompt，以及 Bash、read、write、edit、Glob 和无状态 Todo。
Bash permission 策略分为 allow、ask、deny；ask 通过 `Interactions.permission()` 端口请求外部
回答（once / always / deny），deny 由 Permission listener 在 `tools/pre-execute` 上直接拒绝。
未提供 interactions 时，`NO_INTERACTIONS` 总是返回带 `Permission request failed: interaction
unavailable` 原因的 deny。

Todo 每次接收完整列表，同时返回模型可见的 `content` 和结构化的 `details.todos`。Harness 将
Tool Result 写入 Session，因此恢复状态属于 Session，而不是 Todo Tool 实例。

### 展示边界

`ToolDefinition` 可以在执行定义旁提供 `CodingToolPresentation`。Coding Agent 向下把
定义转换成 `AgentTool`，向上保留 Project 级的 `renderTool()`。`ToolPresentationInput` 只有
`call` 与 `result` 两种变体，仅含渲染数据，不携带 Session/Run 身份。专用展示缺失、返回
`undefined` 或抛错时使用通用 fallback；展示失败只通过 `interactions.notify()` 报告，不改变
Tool 执行结果。

## 6. UI：具体适配器

`src/ui/` 实现 CLI，core 模块不导入它。`CliInteractions` 实现 `confirm()` 和 `notify()`；
`CliHarnessRenderer` 绑定到 `project.events`，按 `sessionId` 过滤并渲染事实事件。

```ts
class CliFrontend {
  constructor(options?: CliFrontendOptions);
  get interactions(): CodingAgentInteractions;
  run(project: Project, harness: AgentHarness): Promise<void>;
  close(): void;
}
```

`run(project, harness)` 让 `CliHarnessRenderer.bind(project.events, harness.sessionId)` 订阅传入
Project 的共享 Events；文本流和运行统计由 CLI 展示，`agent/tool-call` 与 `agent/tool-result`
投影成 `ToolPresentationInput` 交给 `project.renderTool()`。ESC 调用当前 Harness 的 `abort()`。
`confirm()` 显示 `[y/N]`，空输入或 ESC 都拒绝；外部 `AbortSignal` 与 ESC 信号合并。

## 7. main.ts：组合根

启动顺序如下：

1. 加载环境变量并创建 `StreamFn` 与默认模型；
2. `createProject({ keaHome })` 打开或创建持久化 Project（内部建立共享 Events 并注册
   Permission）；
3. 创建 `CliFrontend`，把 `cli.interactions` 注入 `createProject()`；
4. 调用 `project.continueRecent()` 选择 Session 并取得 Harness；
5. 调用 `cli.run(project, harness)`。

Session 的选择发生在 Coding Agent；CLI 只运行已选择的 Harness。

## 8. 公共入口

- `src/core/events/index.ts`：`Events`、`EventMap`；
- `src/core/ai/index.ts`：AI 消息、模型、流和 provider 工厂；
- `src/core/agent/index.ts`：`runAgentLoop`、`AgentRunIdentity`、事件契约和 Tool API；
- `src/core/harness/index.ts`：`AgentHarness`、`Session`、`SessionRepository`、Session 错误和 system
  prompt；
- `src/coding-agent/index.ts`：`createProject`、`Project`、`ProjectInfo`、默认 prompt、
  interactions、`ToolDefinition`/presentation 和 Todo API；
- `src/ui/index.ts`：`CliFrontend`、`CliInteractions`、`CliHarnessRenderer`；
- `src/index.ts`：汇总以上入口和通用 timeout/workspace helpers。

具体内置 Tool/事件工厂、Bash policy、Coding Tool 到 Agent Tool 的转换和 presentation registry
都是内部实现。

## 9. 边界约束

- `ai` 不依赖 `agent`；
- `agent` 不依赖 `harness`、`coding-agent` 或 `ui`；只声明自己的 `EventMap` 契约；
- `harness` 不依赖具体 coding Tool 或 UI；
- `coding-agent` 不依赖 `src/ui`，只定义 `CodingAgentInteractions` 端口；
- `SessionRepository` 管理 Session 集合，`AgentHarness` 只绑定一份 Session；
- `Project` 选择 Project 中的 Session，并直接返回独立 Harness；一份 Project 共享一个
  `Events` 实例；
- 控制事件负责提交前控制，`emit` 事实负责事实通知，presentation 负责 UI 文本；
- `main.ts` 是唯一连接 provider、Project 和具体 CLI 的应用入口。
