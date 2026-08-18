# Kea Agent 架构

**更新：** 2026-08-18

本文描述当前代码的所有权与边界。`ai`、`agent`、`events`、`harness` 共同组成
`src/core/` 下的 Harness 核心。依赖方向是
`main -> ui -> coding-agent -> core/harness -> core/agent -> core/ai`；`core/events` 由核心运行时共享，
`src/application/` 提供配置、参数和目录发现等无长期状态的启动能力，`main.ts` 是连接具体 UI、
Coding Agent 和 AI provider 的唯一组合根。

## 1. AI：LLM 流式协议与显式 Provider

`src/core/ai/` 统一 Anthropic、OpenAI 和 Gemini 的流式协议，不保存会话，也不执行工具。

```ts
interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}

type ProtocolId = "anthropic" | "openai" | "gemini";

interface RuntimeProviderConfig {
  readonly name: string;            // 配置的 provider 名，例如 "deepseek"
  readonly protocol: ProtocolId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

function createModelRuntime(options: {
  readonly providers: readonly RuntimeProviderConfig[];
}): ModelRuntime;
```

`createModelRuntime()` 只接收显式 Provider 列表；`ModelRuntime` 拥有 provider 路由和 lazy
adapter，`ModelConfig` 是“这次请求选择哪个模型”的值，两者分离。Runtime 不保存默认模型；
同一个 Runtime 可服务多个 provider、Session 和模型切换。`ModelRuntime.stream(modelConfig,
context)` 的请求路由到 `modelConfig.provider` 对应的 adapter，请求未配置的 provider 会抛出
`Unknown provider`。provider 是用户配置的连接实例（name/baseUrl/apiKey/protocol/models），
协议决定 adapter；多个 provider 可共用同一协议。默认模型由 `Config.defaultModel` 显式指定。

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
```

`AgentLoopConfig` 携带本轮模型选择（`model`）、可选 `maxTurns` 上限和 `convertToLlm`
消息转换。`AgentContext` 提供 Run 身份、system prompt、消息、Tool Registry、共享 `Events`
和取消信号；`appendMessage()` 由 Harness 提供，负责把完整消息持久化后再发布事实事件。

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
interface SessionMetadata {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSessionId?: string;
}

class SessionRepository {
  constructor(storageDir: string);
  create(options: { readonly cwd: string }): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly SessionMetadata[]>;
}
```

`SessionRepository` 是 Harness 层唯一管理多份 Session 的实体。它在一个 `storageDir` 中创建、
打开和列举 Session；`list()` 按存储的 `updatedAt` 从新到旧返回 `SessionMetadata[]`。
Repository 不创建 Harness，也不保存“当前 Session”。

### AgentHarness

一个 `AgentHarness` 在构造时绑定恰好一份 Session，之后不切换。它公开 `sessionId`、`model`、
`messages` 和 `isRunning`，但不暴露可写 Session 或 Repository。

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly maxTurns?: number;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: Events;
}

class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  get sessionId(): string;
  get model(): ModelConfig;
  get messages(): readonly AgentMessage[];
  get isRunning(): boolean;
}
```

Harness 为这份 Session 持有消息视图、当前模型、Tool Registry、AbortController 和 run 状态。
它构造时接收 Project 提供的共享 `Events`，在 `prompt()` 中创建 Run 身份（`sessionId`、
`runId`），发布 `harness/run-start`，调用一次 `runAgentLoop()`，并发布 `harness/run-end`。
同一个 Harness 同时只运行一个 `prompt()`；运行时切换模型或修改 Tool 会抛错。构造时 Session
已保存的模型优先于 `modelConfig`；`switchModel()` 先持久化 `model_selection` 再更新当前模型，
因此模型切换失败不会改变旧状态。

`subscribe(listener)` 是 UI 唯一的事件入口：Harness 把共享 `Events` 中属于本 Session 的
`emit` 事实投影成 `HarnessEvent`（去掉 Session 身份和所有 intercept 控制点）转发给 listener，
返回幂等取消函数。Project 的原始 `Events` 不公开。

### Harness Event 边界

`src/core/harness/events.ts` 声明 `HarnessEvent` 投影：`run-start`、`run-end` 加上
`turn-start`、`turn-end`、`text-delta`、`thinking-delta`、`tool-call-*`、`tool-call`、
`tool-result`。Listener 观察已经发生的事实，返回值不会改变运行；`emit` 的 listener 错误被
隔离，并交给 `Events` 的错误处理器。

## 5. Coding Agent：Project 级所有者

`src/coding-agent/` 管理持久化 Project，并为每份打开的 Session 建立 coding Harness。

```ts
interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directory: string;       // 绝对、规范化、已存在的 Project 目录
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Project {
  readonly info: ProjectInfo;
  listSessions(): Promise<readonly SessionMetadata[]>;
  createHarness(options?: { readonly cwd?: string }): Promise<AgentHarness>;
  createHarnessFromSession(sessionId: string): Promise<AgentHarness>;
}

function openOrCreateProject(options: {
  readonly keaHome: string;
  readonly projectDirectory: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly interactions: Interactions;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly onListenerError?: (error: unknown, name: string, input: unknown) => void;
}): Promise<Project>;
```

`openOrCreateProject()` 是本包唯一的组合根。目录发现属于 application 层：应用把启动目录
解析为 Git worktree 根（或原目录）并规范化，再把规范结果作为 `projectDirectory` 传入；
Coding Agent 只校验该目录（绝对、`resolve()` 后不变、`realpath()` 后不变、且是现存目录），
不运行 Git。

Project 记录持久化在 `<keaHome>/projects/<projectId>/project.json`，通过规范目录查找复用。
找不到记录时生成 UUID、目录名和 UTC 时间创建新记录。每次组合同时创建
`SessionRepository`、内存权限记录（`approved`，只存在于进程内）和**一个**共享 `Events`
实例，并注册默认 Permission listener。`maxTurns` 和 `toolTimeoutSeconds` 是扁平的运行策略，
直接传给每个 Harness。

`Project.events` 是私有的；UI 通过 `harness.subscribe()` 观察。`createHarness()` 创建新
Session，`createHarnessFromSession()` 恢复已有 Session 并重新验证其 cwd；目录已被删除或不再
是目录时恢复失败，不会悄悄回退到 Project 目录。`-c` 时应用选择 `listSessions()[0]`，空列表
回退为新 Session。

### Session 与 cwd

一份 Session 存储绝对 `cwd`。Coding Agent 给每份 Session 的 Harness 以解析后的 cwd，
工具路径统一从这个 cwd 解析。相对 `cwd` 从 Project 目录解析；最终路径必须存在且是目录。

### 默认 Coding 能力

Coding Agent 提供 coding system prompt，以及 Bash、read、write、edit、Glob 和无状态 Todo。
Bash permission 策略分为 allow、ask、deny；ask 通过 `Interactions.permission()` 端口请求外部
回答（once / always / deny），deny 由 Permission listener 在 `tools/pre-execute` 上直接拒绝。
`Interactions` 必须由调用方显式提供，本包没有默认实现，避免在没有用户确认渠道时静默放行。

## 6. UI：命令语言与命令行实现

`src/ui/` 只提供无终端依赖的命令语言：`parseInput` 把一行输入解析为 `UiAction`
（prompt / new-session / switch-session / switch-model / help / exit / command-error）。
命令行实现位于 `src/ui/cli/`；core 与 coding-agent 不导入任何 UI 层。

```ts
class CliUi {
  readonly interactions: CliInteractions;
  constructor(options: CliUiOptions);   // models、display 设置、reportError、注入目标
  run(project: Project, initialHarness: AgentHarness): Promise<void>;
  close(): void;
}
```

`CliUi` 是线性 Session 循环：一次只读一个 Prompt，`await harness.prompt(text)` 期间不再
读第二个普通 Prompt；Permission 提问发生在 `prompt()` 内部，通过同一 question 函数。命令只在
字符 0 位置匹配精确 slash token（`/new`、`/session`、`/model`、`/help`、`/exit`）；其他输入
原样作为 Prompt。`/session` 与 `/model` 使用一基编号选择器，空输入取消。

`Renderer` 把 `HarnessEvent` 与用户输入投影到终端（thinking 默认隐藏、tool 事实默认 compact）；
`CliInteractions` 实现 `Interactions` 端口，把 `o`/`a`/其它回答映射为 once/always/deny。
Run 取消中止 Permission 提问并传播，普通取消返回 deny。SIGINT 在 `current.isRunning` 时调用
`current.abort()`（包括 Permission 持有提问时）；没有 Run 时留给 readline 自身的输入取消。
Session 或模型切换失败时保留旧 Harness、订阅和模型。

`CliUi` 通过注入的 `reportError` 回调报告捕获的错误，不接触 Config 或凭据。

## 7. application 与 main.ts：组合根

`src/application/` 提供无长期状态的启动能力：`arguments.ts`（argv 解析）、
`project-directory.ts`（启动目录 → Git 根 → 规范目录）、`config.ts`（唯一 Config）和
`init.ts`（用户配置模板）。这些模块只被 `main.ts` 和测试导入。

### Config

`Config` 是唯一的应用设置实体，按优先级分层加载：内建默认值 < `~/.kea/config.json` <
`<project>/.kea/config.json` < `--config` 文件 < CLI 直接覆盖（`--verbose`）。每个普通配置源
独立验证后才合并；普通源拒绝 credential 字段（`apiKey`/`token`/`secret`/`password`）。
凭据只来自 `~/.kea/auth.json`，在所有普通源之后加载。跨字段验证顺序：至少一个 provider →
每个 provider 的 `protocol` 为三者之一、`models` 非空 → `defaultModel` 必填且必须引用已配置
provider 并列出其 `models` 中的模型 → 启用 provider 的 auth key 非空。

`Config` 保持 Provider 凭据私有（`#providers`），公开 `models`、`defaultModel`、
`runtimeProviders()`、`maxTurns`、`toolTimeoutSeconds`、`thinking`、`toolDetails`、`verbose`
和 `redact()`。`redact()` 把所有已加载的非空 API key 替换为 `[REDACTED]`；顶层错误、verbose
日志和 listener 错误都经它输出。

### 启动顺序

1. 解析 argv；
2. `resolveProjectDirectory()` 得到规范 Project 目录；
3. 用户配置文件（`~/.kea/config.json`、`auth.json`）缺失时补建模板（独占创建，绝不
   覆盖，只打印 `created`），然后 `Config.load()` 按上述顺序加载并验证；
4. `createModelRuntime({ providers: config.runtimeProviders() })`；
5. 构造 `CliUi`（models、display 设置、经 `redact()` 的 `reportError`）；
6. `openOrCreateProject()` 打开或创建 Project；
7. `kea -c` 选择最新 Session，否则创建新 Session；
8. `ui.run(project, initial)`；`finally` 中 `ui.close()`（幂等）。

生产启动绝不调用 dotenv，也绝不从 `process.env` 读取 Provider 凭据。

## 8. 公共入口

- `src/core/events/index.ts`：`Events`、`EventMap`；
- `src/core/ai/index.ts`：AI 消息、模型、流和显式 Provider 工厂；
- `src/core/agent/index.ts`：`runAgentLoop`、`AgentRunIdentity`、事件契约和 Tool API；
- `src/core/harness/index.ts`：`AgentHarness`、`HarnessEvent`、`Session`、`SessionRepository`、
  Session 元数据和错误；
- `src/coding-agent/index.ts`：`openOrCreateProject`、`Project`、`ProjectInfo`、`Interactions`
  端口和权限类型；
- `src/ui/index.ts`：`parseInput`、`UiAction`（无终端依赖的命令语言）；
- `src/ui/cli/index.ts`：`CliUi`、`CliInteractions`、`Renderer`（命令行实现）；
- `src/index.ts`：汇总以上入口和通用 workspace helpers。

`src/application/` 保持应用内部：Config、argv、模板创建和目录发现只由 `main.ts` 与测试导入。
具体内置 Tool/事件工厂、Bash policy 和各 Tool 的 details 类型都是内部实现。

## 9. 边界约束

- `ai` 不依赖 `agent`；
- `agent` 不依赖 `harness`、`coding-agent` 或 `ui`；只声明自己的 `EventMap` 契约；
- `harness` 不依赖具体 coding Tool 或 UI；
- `coding-agent` 不依赖 `src/ui` 或 `src/application`，只定义 `Interactions` 端口；
- `application` 不依赖 UI 内部组件；main 从 Config 取出 UI 需要的值传给 UI；
- `SessionRepository` 管理 Session 集合，`AgentHarness` 只绑定一份 Session；
- `Project` 的原始 `Events` 私有；UI 只能通过 `harness.subscribe()` 观察；
- 控制事件负责提交前控制，`emit` 事实负责事实通知；
- `main.ts` 是唯一连接 provider、Project 和具体 CLI 的应用入口；Config 是唯一应用设置实体。
