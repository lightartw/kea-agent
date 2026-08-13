# Kea Agent 架构

**更新：** 2026-08-13

本文描述当前代码的所有权与边界。依赖方向是 `ui -> coding-agent -> harness -> agent -> ai`；
`main.ts` 是连接具体 UI、Coding Agent 和 AI provider 的组合根。

## 1. AI：LLM 流式协议

`src/ai/` 统一 Anthropic、OpenAI 和 Gemini 的流式协议，不保存会话，也不执行工具。

```ts
type StreamFn = (
  model: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<AssistantMessageEvent>;

interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}
```

`createStreamFn()` 返回 `stream` 和 `defaultModel`。Provider adapter 在流第一次迭代时动态加载。
`ToolResultMessage.content` 是模型可见文本；`details` 是 Session、Agent 和 UI 使用的结构化数据，
不会被 provider adapter 发到模型服务。

## 2. Agent：Tool 循环与 Hook 控制

`src/agent/` 用 `runAgentLoop()` 执行一次多 Turn Agent Run。它接收消息、
`AgentToolRegistry`、模型、`StreamFn` 和收窄的 `AgentHookTrigger`，并产生 `AgentEvent`。

每个 Tool Call 先经过 `tool_call` Hook，再由 Registry 完成 lookup 和参数验证。只有准备成功的
调用才发布 `tool_start` 并执行；被 Hook 阻止、参数无效、工具未知或中止的调用都会生成一条
synthetic Tool Result，并以 `tool_rejected` 结束。成功开始的调用以 `tool_end` 结束。

### Hook 边界

`HookRegistry<TContext>` 是配置和组合 Hook 的完整接口；Agent Loop 与 Harness 只依赖
`AgentHookTrigger.trigger()`。五类 Hook Call 分别控制：

| Call | 作用 |
| ---- | ---- |
| `user_prompt` | 提交 user message 前允许或阻止 |
| `context` | 每次 LLM 请求前转换消息快照 |
| `tool_call` | Tool 验证和执行前修改参数或阻止 |
| `tool_result` | Tool Result 提交前修改结果 |
| `stop` | Agent 停止前请求继续 |

Hook 是控制通道，可以改变尚未提交的行为。它不是被动 listener；已经发生的运行事实由 Harness
Event 报告。

### Tool 边界

`AgentTool` 定义 schema 和执行，`AgentToolRegistry` 负责注册、准备、timeout 与异常归一化。
Agent Tool 不依赖 Coding Agent 或 UI，也不携带展示逻辑。

## 3. Harness：一份 Session 的运行器

`src/harness/` 提供 Session 数据、Repository 和 Session 运行能力。

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
  subscribe(listener: HarnessListener): Unsubscribe;
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

Harness 为这份 Session 持有消息视图、当前模型、Tool Registry、Hook Trigger、Event Bus、
AbortController 和 run 状态。同一个 Harness 同时只运行一个 `prompt()`；运行时切换模型或修改
Tool 会抛错。Harness 在发布对应 Event 前把新增消息写回 Session。

### Harness Event 边界

`subscribe()` 接收带 `runId` 和 `lane` 的 `HarnessEvent`。Harness 发布 `run_start`、`run_end`，
并把 Agent Event 提升为 Harness Event。Listener 观察已经发生的事实，返回值不会改变运行；
listener 错误被 Event Bus 隔离，并交给可选的 `onEventListenerError`。

## 4. Coding Agent：Project 级所有者

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
  listSessions(): Promise<readonly SessionInfo[]>;
  createSession(options?: CreateSessionOptions): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  update(input: UpdateProjectInput): Promise<ProjectInfo>;
  renderToolEvent(event: HarnessToolEvent): string;
}

interface CreateProjectConfig {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

function createProject(config: CreateProjectConfig): Promise<Project>;
```

Project 元数据持久化在 `<keaHome>/projects/<id>/project.json`。`createProject()` 先扫描已注册
Project：当启动目录位于某 Project 的 `directories` 之下时复用该 Project（嵌套时选最长）；
否则显式 `directory` 成为新根；否则从 `git rev-parse --show-toplevel` 发现根，失败则回退为
启动 `cwd`。Git 只影响发现；每个非 Git 根目录都有独立 Project 存储。

`Project` 用 `keaHome/projects/<id>` 建立 `SessionRepository`。`continueRecent()` 打开最近的
Session；没有历史时按启动 cwd 创建。Session 方法返回 `AgentHarness`，调用方直接使用它。

每次 `createSession()`、`openSession()` 或 `continueRecent()` 分配 Harness 时，Coding Agent 都
新建 Tool Registry、所有 Tool 实例、permission Hook Registry、标题生成器和 AgentHarness；
Harness 又建立自己的 Event Bus、模型与 run 状态。因此多份打开的 Session 之间没有共享的可变
Tool、Hook、Event、模型或运行状态。

### Session 与 cwd

一份 Session 存储一个选中的 Project 目录加相对 `cwd`。Coding Agent 给每份 Session 的 Harness
以解析后的绝对 cwd，并把完整 `directories` 交给 Coding Tools；文件 Tool 用
`safePath(cwd, directories, path)` 拒绝离开全部 Project 目录的路径。切换 `primaryDirectory`
只影响之后创建的 Session，不改写已有 Session 文件。

### 默认 Coding 能力

Coding Agent 提供 coding system prompt，以及 Bash、read、write、edit、Glob 和无状态 Todo。
Bash permission 策略分为 allow、ask、deny；ask 通过 `CodingAgentInteractions.confirm()` 请求
具体 UI，deny 同时由 Hook 和 Bash Tool 防守。未提供 interactions 时，`NO_INTERACTIONS`
默认拒绝确认请求。

Todo 每次接收完整列表，同时返回模型可见的 `content` 和结构化的 `details.todos`。Harness 将
Tool Result 写入 Session，因此恢复状态属于 Session，而不是 Todo Tool 实例。

### 自动标题

`createProject()` 给每个 Harness 注入 `createSessionTitleGenerator(config.streamFn)`。新 Session
立即以 `"unknown"` 标题持久化；第一个真实 user 消息持久化后，标题请求并发运行，用
`setTitleIfUnknown()` 写入单行 ≤100 字符标题。它不阻塞或失败 Agent Run，也不覆盖已修改标题。

### 展示边界

`CodingToolDefinition` 可以在执行定义旁提供 `CodingToolPresentation`。Coding Agent 向下把
定义转换成 `AgentTool`，向上保留 Project 级的 `renderToolEvent()`。专用展示缺失、返回
`undefined` 或抛错时使用通用 fallback；展示失败只通过 `interactions.notify()` 报告，不改变
Tool 执行结果。

## 5. UI：具体适配器

`src/ui/` 实现 CLI，core 模块不导入它。`CliInteractions` 实现 `confirm()` 和 `notify()`；
`CliHarnessRenderer` 消费 Harness Event，并调用 Coding Agent 的工具展示入口。

```ts
class CliFrontend {
  constructor(options?: CliFrontendOptions);
  get interactions(): CodingAgentInteractions;
  run(project: Project, harness: AgentHarness): Promise<void>;
  close(): void;
}
```

`run(project, harness)` 订阅传入 Harness；文本流和运行统计由 CLI 展示，Tool Event 交给
`project.renderToolEvent()`。ESC 调用当前 Harness 的 `abort()`。`confirm()` 显示 `[y/N]`，
空输入或 ESC 都拒绝；外部 `AbortSignal` 与 ESC 信号合并。

## 6. main.ts：组合根

启动顺序如下：

1. 加载环境变量并创建 `StreamFn` 与默认模型；
2. `createProject({ keaHome })` 打开或创建持久化 Project；
3. 创建 `CliFrontend`，把 `cli.interactions` 注入 `createProject()`；
4. 调用 `project.continueRecent()` 选择 Session 并取得 Harness；
5. 调用 `cli.run(project, harness)`。

Session 的选择发生在 Coding Agent；CLI 只运行已选择的 Harness。

## 7. 公共入口

- `src/ai/index.ts`：AI 消息、模型、流和 provider 工厂；
- `src/agent/index.ts`：`runAgentLoop`、Agent Event、Hook 和 Tool API；
- `src/harness/index.ts`：`AgentHarness`、`Session`、`SessionRepository`、Session 错误、system
  prompt、Harness Event 与 Session 元数据 API；
- `src/coding-agent/index.ts`：`createProject`、`Project`、`ProjectInfo`、默认 prompt、
  interactions、Coding Tool/presentation 和 Todo API；
- `src/ui/index.ts`：`CliFrontend`、`CliInteractions`、`CliHarnessRenderer`；
- `src/index.ts`：汇总以上入口和通用 timeout/workspace helpers。

具体内置 Tool/Hook 工厂、Bash policy、Coding Tool 到 Agent Tool 的转换、presentation registry、
`PreparedAgentToolCall` 和 `ToolPreparation` 都是内部实现。

## 8. 边界约束

- `ai` 不依赖 `agent`；
- `agent` 不依赖 `harness`、`coding-agent` 或 `ui`；
- `harness` 不依赖具体 coding Tool 或 UI，只定义 `SessionTitleGenerator` 类型；
- `coding-agent` 不依赖 `src/ui`，只定义 `CodingAgentInteractions` 端口；
- `SessionRepository` 管理 Session 集合，`AgentHarness` 只绑定一份 Session；
- `Project` 选择 Project 中的 Session，并直接返回独立 Harness；
- Hook 负责提交前控制，Harness Event 负责事实通知，presentation 负责 UI 文本；
- `main.ts` 是唯一连接 provider、Project 和具体 CLI 的应用入口。
