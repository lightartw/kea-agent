# Kea Agent 架构

**更新：** 2026-08-20

本文描述当前代码的所有权与边界。`ai`、`harness` 共同组成 `src/core/` 下的 Harness 核心。依赖
方向是 `main -> ui -> coding-agent -> core/harness -> core/ai`；`coding-agent/cli` 与
`coding-agent/config` 提供配置、参数、模板和目录发现等无长期状态的启动能力，`main.ts` 是连接
具体 UI、Coding Agent 和 AI provider 的唯一组合根。

观察事件与控制钩子都由 `harness` 拥有（`HarnessEventBus` + `HarnessHooks`），不存在独立的
`events` 包。

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

`StreamChunk` 是一次 provider 响应中的一个片段，由 Agent 直接消费；它不是运行事件（不注册、
发布或观察），只是从 provider 到 agent 的数据传输。每一轮 Stream 必须以 `done` 或 `error`
终止块结束；Agent 在缺少终止块时让 Run 失败，不发布没有完整消息的 `turn-end`。

## 2. 观察事件与控制钩子

`harness` 把“观察”与“控制”明确分开，且都由调用方创建后注入 `AgentHarness`。

### 观察事件：`HarnessEventBus`（`src/core/harness/events.ts`）

`HarnessEventBus` 是纯观察总线：`on(type, listener)` 注册，`emit(event)` 发布；listener 返回
`void`，逐个按注册顺序 await，异常经错误处理器隔离，不改变 harness 执行。

事件类型是 `HarnessEvent` 的判别联合，携带 `runId`（无 `sessionId`，因为每个 Harness 已绑定
一份 Session）：

- Run 边界：`run-start`、`run-end`；
- Turn 边界：`turn-start`、`turn-end`；
- 流式：`text-start`/`text-end`、`thinking-start`/`thinking-end`、`text-delta`、
  `thinking-delta`；
- Tool：`tool-call-start`、`tool-call-delta`、`tool-call`、`tool-result`。

### 控制钩子：`HarnessHooks`（`src/core/harness/hooks.ts`）

`HarnessHooks` 是一组**固定命名**的控制点，handler 通过返回值影响流程：

```ts
type HookName = "beforePrompt" | "transformContext" | "beforeTool";

// beforePrompt(prompt, ctx) → string | undefined   （改写 prompt；undefined 停止 Run）
// transformContext(messages, ctx) → messages        （整理每次 LLM 请求快照）
// beforeTool(call, ctx) → PreToolDecision           （{allow} | {deny, reason?}，权限用）
```

多 handler 通过统一原语组合：变换钩子链式传递，`beforeTool` 首个 `deny` 短路。

## 3. Agent Harness：通用 agent 运行时

`src/core/harness/` 是通用 agent 的实现，包含三大能力与一个组合根：

- **agent-loop**：`runAgentLoop()` 无状态执行一次多 Turn Agent Run；
- **tools**：`AgentTool`/`AgentToolRegistry` 提供工具定义、校验与执行，权限经 `beforeTool`
  钩子完成；
- **session**：`Session`/`SessionRepository` 提供会话数据与持久化；
- **AgentHarness**：session-bound 的组合根，把三者绑成一份 Session 的运行器。

### agent-loop

`runAgentLoop()` 接收用户输入、`AgentContext`、`AgentLoopConfig` 与 `StreamFn`，并产生
`Promise<void>`。

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
): Promise<void>;
```

`AgentLoopConfig` 携带本轮模型选择（`model`）、可选 `maxTurns` 上限和 `convertToLlm` 消息
转换。`AgentContext` 提供 Run 身份、system prompt、消息、Tool Registry、观察总线 `events`、
控制钩子 `hooks` 和取消信号；`appendMessage()` 由 Harness 提供，负责把完整消息持久化后再发布
事实事件。

一个 Turn 的顺序：`turn-start` → `hooks.transformContext`（整理消息快照）→ 流式
`text-delta`/`thinking-delta`/`tool-call-*` → `done` 终止块后完整 assistant 消息写入 →
逐个执行 Tool → `turn-end`。用户 prompt 先经 `hooks.beforePrompt` 处理。Turn 后是否继续由
Agent Loop 内建决定：本轮有 Tool Result 就继续，让模型消费结果；没有则结束。

### Tool

每个 Tool Call 在 `AgentToolRegistry.execute()` 内先做 lookup 和 TypeBox 校验，再调用
`hooks.beforeTool` 做权限决策；拒绝时统一转换成错误结果。允许后经 timeout helper 调用 Tool
本体。未知、无效、被阻止、已中止或失败的调用都以恰好一个 `tool-result` 结束。不存在
`tools/pre-execute`/`execute`/`post-execute` 三阶段拦截——控制只通过 `beforeTool` 钩子。

### session

`Session` 保存消息、模型变更和 Session ID。持久化格式是
`<storageDir>/sessions/<sessionId>.jsonl` 的树形 entry；`buildContext()` 沿当前叶节点的父链恢复
消息和最后选择的模型。标题是 header 字段（`setTitle` 原地重写 header），不是追加记录。

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

### AgentHarness

一个 `AgentHarness` 在构造时绑定恰好一份 Session，之后不切换。它公开 `sessionId`、`model`、
`messages`、`isRunning`、`hooks` 和 `subscribe`，但不暴露可写 Session 或 Repository。

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly maxTurns?: number;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: HarnessEventBus;   // 观察事件总线，调用方创建
  readonly hooks: HarnessHooks;       // 控制钩子，调用方创建并预注册
}

class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  get hooks(): HarnessHooks;
  get sessionId(): string;
  get model(): ModelConfig;
  get messages(): readonly AgentMessage[];
  get isRunning(): boolean;
}
```

Harness 为这份 Session 持有消息视图、当前模型、Tool Registry、AbortController 和 run 状态。
`prompt()` 创建 Run 身份（`sessionId`、`runId`），在自持总线上发布 `run-start`，调用一次
`runAgentLoop()`，并发布 `run-end`。同一个 Harness 同时只运行一个 `prompt()`；运行时切换模型或
修改 Tool 会抛错。构造时 Session 已保存的模型优先于 `modelConfig`；`switchModel()` 先持久化
`model_selection` 再更新当前模型。

`subscribe(listener)` 把 Harness 发布到自持总线上的 `HarnessEvent` 直接转交给 listener（每个
Harness 绑定一份 Session，无需按 `sessionId` 过滤），返回幂等取消函数。`hooks` 暴露控制钩子
注册面，供调用方在创建 `HarnessHooks` 时预注册。

## 4. Coding Agent：Project 级所有者

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
  readonly interaction: UserInteraction;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
}): Promise<Project>;
```

`openOrCreateProject()` 是本包唯一的组合根。目录发现属于 application 层：应用把启动目录解析为
Git worktree 根（或原目录）并规范化，再把规范结果作为 `projectDirectory` 传入；Coding Agent 只
校验该目录（绝对、`resolve()` 后不变、`realpath()` 后不变、且是现存目录），不运行 Git。

Project 记录持久化在 `<keaHome>/projects/<projectId>/project.json`，通过规范目录查找复用。找不到
记录时生成 UUID、目录名和 UTC 时间创建新记录。Project 持有内存权限状态（`approved`）和注入的
`UserInteraction`。

`Project.createHarness()` / `createHarnessFromSession()` 逐 Harness 装配：用
`createBuiltinToolRegistry(cwd, timeout)` 建工具、用 `createHooks(state)` 建已注册内置钩子的
`HarnessHooks`、用 `new HarnessEventBus()` 建观察总线，连同 system prompt 一起注入
`AgentHarness`。Project 不对外暴露注册 Tool / 钩子的接口（无插件系统）。

### 权限：内置 `beforeTool` 钩子

`createHooks()`（`coding-agent/hooks/factory.ts`）创建一个 `HarnessHooks` 并把权限的
`beforeTool` 决策注册到它上面（这是内置钩子之一）。Bash permission 策略分为 allow、ask、deny：
ask 通过 `UserInteraction.select(["Allow once", "Always allow", "Deny"])` 请求外部回答；hard deny
在钩子内直接拒绝。`UserInteraction` 必须由调用方显式提供，本包没有默认实现。

## 5. UI：命令语言与命令行实现

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

`CliUi` 是线性 Session 循环：一次只读一个 Prompt，`await harness.prompt(text)` 期间不再读第二个
普通 Prompt；Permission 提问发生在 `prompt()` 内部，通过同一 question 函数。命令只在字符 0 位置
匹配精确 slash token（`/new`、`/session`、`/model`、`/help`、`/exit`）；其他输入原样作为 Prompt。

`Renderer` 把 `HarnessEvent` 与用户输入投影到终端（thinking 默认可见、tool 事实默认 compact）；
`CliInteractions` 实现 `UserInteraction` 端口，把 `select`/`confirm`/`input` 映射到 readline
question 函数。Run 取消中止交互提问并传播，普通取消返回中性值。SIGINT 在 `current.isRunning` 时
调用 `current.abort()`；没有 Run 时留给 readline 自身的输入取消。Session 或模型切换失败时保留旧
Harness、订阅和模型。

`CliUi` 通过注入的 `reportError` 回调报告捕获的错误，不接触 Config 或凭据。

## 6. 启动层与 main.ts：组合根

`coding-agent/cli` 与 `coding-agent/config` 提供无长期状态的启动能力：`cli/args.ts`（argv
解析，返回 `diagnostics` 而非抛错）、`cli/project-directory.ts`（启动目录 → Git 根 → 规范目录）、
`config/config.ts`（唯一 Config 与 `loadConfig` 引导入口）、`config/defaults.ts`、
`config/schema.ts`（读取、解析与校验）和 `config/templates.ts`（用户配置模板）。这些模块只被
`main.ts` 和测试导入，不依赖 UI 或 Coding Agent 的领域内部组件。

### Config 与 loadConfig

`Config` 是唯一的应用设置实体，按优先级分层加载：内建默认值 < `~/.kea/config.json` <
`<project>/.kea/config.json` < `--config` 文件 < CLI 直接覆盖（`--verbose`）。每个普通配置源
独立验证后才合并；普通源拒绝 credential 字段（`apiKey`/`token`/`secret`/`password`）。凭据只来自
`~/.kea/auth.json`，在所有普通源之后加载。跨字段验证顺序：至少一个 provider → 每个 provider 的
`protocol` 为三者之一、`models` 非空 → `defaultModel` 必填且必须引用已配置 provider 并列出其
`models` 中的模型 → 启用 provider 的 auth key 非空。

`Config.load` 是纯加载：显式 `keaHome`、不建模板。应用引导入口 `loadConfig` 计算 `keaHome`
（默认 `~/.kea`）、补建缺失模板、对 created 文件打印 `<path>: created`，再转调 `Config.load`，
并返回 `{ config, keaHome }` 供 `openOrCreateProject` 使用。

`Config` 保持 Provider 凭据私有（`#providers`），公开 `models`、`defaultModel`、
`runtimeProviders()`、`maxTurns`、`toolTimeoutSeconds`、`thinking`、`toolDetails`、`verbose`
和 `redact()`。`redact()` 把所有已加载的非空 API key 替换为 `[REDACTED]`；顶层错误与 verbose
日志经它输出。

### 启动顺序

1. `parseArgs()` 解析 argv，参数错误进 `diagnostics`；
2. `resolveProjectDirectory()` 得到规范 Project 目录；
3. `loadConfig()` 计算 `keaHome`、补建用户配置模板（独占创建，绝不覆盖，只打印 `created`），
   再按上述顺序加载并验证，返回 `{ config, keaHome }`；
4. `createModelRuntime({ providers: config.runtimeProviders() })`；
5. 构造 `CliUi`（models、display 设置、经 `redact()` 的 `reportError`）；
6. `openOrCreateProject()` 打开或创建 Project；
7. `kea -c` 选择最新 Session，否则创建新 Session；
8. `ui.run(project, initial)`；`finally` 中 `ui.close()`（幂等）。

生产启动绝不调用 dotenv，也绝不从 `process.env` 读取 Provider 凭据。

## 7. 公共入口

- `src/core/ai/index.ts`：AI 消息、模型、流和显式 Provider 工厂；
- `src/core/harness/index.ts`：`runAgentLoop`、`AgentTool`/`AgentToolRegistry`、`AgentHarness`、
  `HarnessEvent`/`HarnessEventBus`、`HarnessHooks`/`HookName`/`HookContext`/`PreToolDecision`、
  `Session`、`SessionRepository`、Session 元数据和错误、`AgentRunIdentity` 与事件/钩子契约；
- `src/coding-agent/index.ts`：`openOrCreateProject`、`Project`、`ProjectInfo`、
  `UserInteraction`/`InteractionOptions`；
- `src/ui/index.ts`：`parseInput`、`UiAction`（无终端依赖的命令语言）；
- `src/ui/cli/index.ts`：`CliUi`、`CliInteractions`、`Renderer`（命令行实现）；
- `src/index.ts`：汇总以上入口和通用 workspace helpers。

`coding-agent/cli` 与 `coding-agent/config` 保持应用内部：args、Config、模板创建和目录发现只由
`main.ts` 与测试导入。具体内置 Tool/hook factory、Bash policy 和各 Tool 的 details 类型都是内部
实现。

## 8. 边界约束

- `ai` 不依赖 `harness`；
- `harness` 不依赖 `coding-agent` 或 `ui`；agent-loop、Tool、观察事件与控制钩子同属本包；
- `harness` 不依赖具体 coding Tool 或 UI；
- `coding-agent` 的领域内部组件（project/tools/hooks/interaction）不依赖 `src/ui` 或
  `coding-agent/cli`、`coding-agent/config`，只定义 `UserInteraction` 端口；
- `coding-agent/cli` 与 `coding-agent/config` 不依赖 UI，也不依赖 Coding Agent 的领域内部组件；
  main 从 Config 取出 UI 需要的值传给 UI；
- `SessionRepository` 管理 Session 集合，`AgentHarness` 只绑定一份 Session；
- UI 只能通过 `harness.subscribe()` 观察；控制钩子通过 `harness.hooks.on()` 注册；
- 观察事件只通知已发生的事实，控制钩子负责提交前控制；
- `main.ts` 是唯一连接 provider、Project 和具体 CLI 的应用入口；Config 是唯一应用设置实体。
