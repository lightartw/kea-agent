# Harness 运行时重设计

日期：2026-07-25

状态：设计已批准，尚未实现

## 背景

当前 `src/harness/agent-harness.ts` 同时定义配置类型、工厂函数、Hook 到 Agent 回调的翻译、Agent 生命周期管理、Session 同步、模型切换和工具注册。`src/harness/hooks/` 又把权限、日志、占位总结、Todo 提醒等不同性质的行为统一塞进一个宽泛的 `HookResult`。这使 Harness 的核心职责不清楚，也产生了实际问题：

- `prompt()` 依赖调用者完整消费 `AsyncIterable` 才会在末尾批量保存消息；
- 调用者提前停止迭代时，消息可能不落入 Session；
- HookRegistry 遇到第一个非空结果就停止，无法正确组合多个修改型 hook；
- 多个默认 hook 只是打印日志，并没有 README 声称的行为；
- Todo hook 和 Todo 工具使用模块全局状态，会跨 Session 泄漏；
- `PermissionHook` 和 `BashTool` 分别维护危险命令规则，可能产生不一致；
- `Session.open()` 会把不存在的文件当成空 Session；
- `Session` 在持久化失败前已经修改内存树，可能与磁盘状态不一致；
- `CreateHarnessConfig.cwd` 与 `project.workDir` 表达同一个概念。

本设计参考 Pi 当前实际使用的 `Agent` + `AgentSession` 结构，但不复制 Pi 完整 extensions、压缩、分支、队列和重试系统。Pi 的关键经验是让应用运行时内部消费 Agent 事件、负责 Session 持久化，再向 UI 提供订阅；不是照抄庞大的 `AgentSession` 或新的实验性 `AgentHarness`。

## 目标

Harness 对外是 Coding Agent 的应用运行时，对内区分通用 Harness 机制和 Coding Agent 默认装配。

首版只完成一个可靠的最小闭环：

- 驱动一次 Agent prompt 到结束；
- 同步 Agent transcript 与 Session；
- 通过 subscriber 发布运行事件；
- 支持 abort；
- 支持 idle 状态下切换模型；
- 支持 idle 状态下注册和注销工具；
- 每轮根据当前模型、工具和工作目录构建 system prompt；
- 从已有 Session 恢复消息和最近使用的模型；
- 保留 Session 的树形持久化基础。

## 非目标

本次不实现：

- Harness hooks 或插件系统；
- `on()` 风格的分类事件 API；
- steer、follow-up 或消息队列；
- 自动重试；
- 上下文压缩；
- Session 分支、导航或总结；
- skills 和 prompt templates；
- provider 配置、环境变量加载或鉴权；
- 大输出截断；
- Todo 自动提醒；
- Agent 包的 subscribe API；
- Agent loop 输出协议重构。

这些能力以后必须从明确产品需求出发单独设计，不能预先塞进核心类。

## 总体架构

采用类中心方案：`AgentHarness.prompt()` 本身就是 Harness 的核心入口，不增加 `runHarnessTurn()`、HarnessRunner、EventBus、SessionSynchronizer 等实体。

核心行为定义为：

> `AgentHarness.prompt()` 接受一次用户输入，驱动 Agent 完成运行，将新形成的稳定消息同步到 Session，将 Agent 生命周期事件发布给 subscribers，并在运行结束后恢复 idle。

职责划分：

- `ai`：provider 路由、LLM 请求、流式响应和 AI 协议类型；
- `agent`：agent loop、Agent 状态、AgentEvent、工具校验和执行；
- `harness`：Session 生命周期、Agent 驱动、消息持久化、模型和工具配置、system prompt、事件订阅；
- CLI/TUI：输入、渲染和用户交互。

Harness 可以直接使用 `ModelConfig` 和 `StreamFn`。不为完全相同的类型逐层创建 `AgentModelConfig`、`HarnessModelConfig`、`AgentStreamFn` 或 `HarnessStreamFn` 别名。只有语义真正分叉或类型确实扩展时才建立平行概念和翻译层。

`AgentMessage` 保留，因为它表达 Agent transcript，未来可以扩展为 AI `Message` 与 Agent 自定义消息的联合类型。Session 保存 `AgentMessage`，而不是直接保存 AI `Message`。

## 文件结构

```text
src/harness/
├── agent-harness.ts          通用 Harness 核心类
├── types.ts                  Harness 公共类型
├── factory.ts                Coding Agent 默认装配
├── index.ts                  公共导出
├── system-prompt.ts          通用 builder 和模板格式化
├── coding-system-prompt.ts   默认 Coding Agent prompt
├── session/
│   ├── session.ts            Session 行为
│   └── types.ts              Session 类型和错误
└── tools/
    ├── factory.ts            默认 Coding Agent 工具集
    ├── bash.ts
    ├── bash-ops.ts
    ├── files.ts
    ├── glob.ts
    └── todo-write.ts
```

删除整个 `src/harness/hooks/`。

通用部分包括 `agent-harness.ts`、`types.ts`、`system-prompt.ts` 和 `session/`。Coding Agent 部分包括 `factory.ts`、`coding-system-prompt.ts` 和 `tools/`。

`AgentHarness` 不得导入默认 coding prompt 或任何具体 coding tool。`factory.ts` 是唯一同时了解通用 Harness、默认 prompt 和默认工具的 composition root。

## 公共类型

`src/harness/types.ts` 定义：

```ts
export type HarnessEventListener = (
  event: AgentEvent,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

export type SystemPromptBuilder = (
  context: SystemPromptContext,
) => string | Promise<string>;

export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
}

export interface HarnessProject {
  readonly workDir: string;
  readonly storageDir: string;
}

export interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
}
```

不定义仅用于改名的 `HarnessMessage` 或 `HarnessEvent`。Harness 的公开 getter 和 listener 直接使用 `AgentMessage` 与 `AgentEvent`。

## AgentHarness 公共接口

```ts
export class AgentHarness {
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

`prompt()` 返回 `Promise<void>`。最终消息已经进入 `messages` 和事件流，首版不增加 `HarnessPromptResult`。

同一 Harness 同时只允许一个 prompt。运行中调用 `prompt()`、`switchModel()`、`registerTool()` 或 `unregisterTool()` 抛出 `Error("AgentHarness is busy")`。`abort()` 在 idle 时无效果并且可重复调用。

`isRunning` 表示完整 Harness run，而不只是底层 Agent 正在 stream：

- system prompt 准备中；
- Agent 运行中；
- subscriber 执行中；
- 最终 Session 同步中。

AgentHarness 自己维护 `running` 与 `abortRequested` 状态，不能只转发 `agent.isRunning`。这是因为异步 system prompt builder 会在 Agent 启动前产生等待窗口。

## prompt 核心流程

每次 prompt 开始前：

1. 同步确认 Harness idle，并在第一次 `await` 之前设置 `running = true`；
2. 重置 `abortRequested = false`；
3. 读取当前模型和当前工具列表；
4. 等待 `SystemPromptBuilder`；
5. 如果准备期间收到 abort，则不启动 Agent；
6. 更新现有 Agent 的 model 与 system prompt；
7. 开始消费 `agent.prompt(input)`。

核心伪代码：

```ts
async prompt(input: string): Promise<void> {
  this.assertIdle();
  this.running = true;
  this.abortRequested = false;

  try {
    await this.prepareAgentForRun();
    if (this.abortRequested) return;

    for await (const event of this.agent.prompt(input)) {
      await this.persistNewMessages();
      await this.publish(event);
    }
  } finally {
    try {
      await this.persistNewMessages();
    } finally {
      this.running = false;
      this.abortRequested = false;
    }
  }
}
```

Harness 初始化时记录从 Session 恢复的消息数量：

```ts
private persistedMessageCount: number;
```

每次 Agent 事件形成后，比较 `agent.messages.length` 与该计数，将所有新增 `AgentMessage` 按顺序交给 `Session.appendMessage()`。每条写入成功后才推进计数。

事件处理顺序固定为：

```text
Agent 更新 transcript
→ Harness 将新增稳定消息追加到 Session
→ Harness 依次等待 subscribers
→ Agent loop 继续
```

因此 subscriber 收到 `turn_end` 或 `tool_end` 时，对应稳定消息已经属于 Session。Harness 不在整个 prompt 结束后批量复制 transcript。

如果 subscriber 或 Session 写入失败，`prompt()` reject，当前 Agent 迭代结束，finally 再尝试同步已经形成但尚未计数的消息。已成功保存的 Session entry 不回滚。

## 订阅语义

AgentHarness 只提供一种只读观察机制：

```ts
subscribe(listener: HarnessEventListener): Unsubscribe;
```

内部使用 `Set<HarnessEventListener>`。发布事件前复制 listener 快照，按注册顺序逐个 `await`。处理当前事件期间发生的订阅或取消只影响下一个事件。

取消函数幂等。listener 返回值被忽略，不能修改 Agent 行为。listener 抛错时原错误直接从 `prompt()` 抛出，后续 listener 不再执行。需要隔离失败的日志 listener 必须自行捕获错误。

不增加 `on()`、EventBus、优先级、后台事件队列或 listener error handler。

## Session 设计

### 类型

`src/harness/session/types.ts` 定义：

```ts
export interface SessionEntryBase {
  readonly id: string;
  readonly parentId: string | null;
}

export interface SessionMessageEntry extends SessionEntryBase {
  readonly type: "message";
  readonly message: AgentMessage;
}

export interface SessionModelChangeEntry extends SessionEntryBase {
  readonly type: "model_change";
  readonly provider: string;
  readonly modelId: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | SessionModelChangeEntry;

export interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}
```

首版不预先增加 compaction、branch summary、label 或 custom entry。

### 公共 API

```ts
export class Session {
  readonly id: string;

  static create(storageDir: string): Promise<Session>;
  static open(storageDir: string, sessionId: string): Promise<Session>;
  static inMemory(): Session;

  appendMessage(message: AgentMessage): Promise<void>;
  appendModelChange(model: ModelConfig): Promise<void>;
  buildContext(): SessionContext;
}
```

删除重复的 `messages()`。`appendModelChange()` 接受完整 `ModelConfig`，entry 内部只保存 provider 和 model ID。

### 树结构

Session 继续维护 `entries`、`byId` 和 `leafId`。新 entry 的 parent 是当前 leaf，追加后 leaf 前移。`buildContext()` 从 leaf 沿 parentId 回到 root，再正序生成当前分支消息和最后一个模型变更。

首版不公开 `moveTo()`、`fork()`、`getEntries()` 或其他分支操作。原始 entry 类型不从 Harness 包入口导出，因为公共 API 不接受或返回它们。

### 延迟落盘

延续 Pi coding-agent 和当前 Kea 的策略：

- entry 立即进入内存树；
- 第一条 assistant message 出现前不创建 JSONL；
- 第一条 assistant message 出现时一次性写入现有全部 entries；
- 此后每个 entry 立即追加；
- `Session.inMemory()` 永不执行文件操作。

Harness 只决定何时调用 `appendMessage()`；是否实际写文件完全由 Session 决定。

### 写入一致性

Session 追加时先暂时更新内存，以便首次 assistant flush 能看到全部 entries；如果持久化失败，必须删除刚加入的 entry、恢复旧 leaf，并重新抛出错误。失败的 append 不属于 Session。

### 打开与校验

`Session.open()` 必须：

- 校验 session ID，拒绝路径分隔符和 `..`；
- 将路径限制在 `<storageDir>/sessions`；
- 文件不存在时抛出 `SessionError("not_found")`；
- 空文件或无效 JSON 时抛出 `SessionError("invalid_session")`；
- entry 缺少必要字段时抛出 `SessionError("invalid_entry")`；
- 未知 entry 类型时报错，不静默忽略。

新建但还没有 assistant message 的 Session 没有文件，因此不能恢复。这是延迟落盘策略的明确代价。

### Session 错误

```ts
export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_entry"
  | "storage";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
}
```

Node 文件系统错误包装为带 cause 的 `SessionError("storage")`，ENOENT 转换为 `not_found`。

AgentHarness 首版不增加统一错误类：busy 使用普通 Error，subscriber、Agent 和工具注册错误保留原始类型，Session 错误保留 SessionError。

## 模型状态

构造 AgentHarness 时读取一次 `session.buildContext()`：

- context messages 初始化 Agent；
- `context.model ?? config.model` 成为当前模型；
- `persistedMessageCount` 初始化为恢复消息数量。

把 Session 交给 AgentHarness 后，调用者不得并行直接修改它。首版不增加锁或 ownership wrapper。

`switchModel()` 只允许 idle：

```ts
async switchModel(model: ModelConfig): Promise<void> {
  this.assertIdle();
  await this.session.appendModelChange(model);
  this.currentModel = model;
  this.agent.model = model;
}
```

先持久化再修改内存，Session 失败时模型保持不变。切换 provider 和切换 model 是同一个操作。Harness 不创建 provider client；现有 StreamFn 根据每次传入的 ModelConfig 路由。

`abort()` 在 active run 中先设置 `abortRequested = true`，再调用 `agent.abort()`。如果 Agent 尚未启动，prompt 会在 system prompt builder 返回后直接结束；如果 Agent 已启动，则由其 AbortSignal 完成取消。Harness 直到最终 Session 同步结束后才恢复 idle。

## 工具状态

AgentHarness 与 Agent 共享一个 `AgentToolRegistry`。注册和注销只允许 idle，下一次 prompt 的 system prompt 和 Agent context 使用最新工具集合。

`createToolRegistry(cwd)` 要求显式工作目录，并为每个 Harness 创建新的具体工具实例。

删除 Harness hooks 后：

- 危险 Bash 检查合并到 `BashTool.execute()`，成为工具自身不变量；
- 原 `PermissionHook` 与 `BashTool` 的两份规则合并为一份；
- 危险检查 helper 不从包入口导出；
- `ContextInjectHook` 删除，cwd 已存在于 system prompt；
- `LogHook` 和 `SummaryHook` 删除，观察需求使用 subscriber；
- `LargeOutputHook` 删除，当前实现只有 console warning，不虚构截断能力；
- Todo reset/called/remind hooks 删除，首版没有 Todo 提醒需求。

`TodoWriteTool` 把 todo 数组改为实例字段。删除模块全局 `currentTodos` 与 `getCurrentTodos()`，不同 Harness 的 Todo 状态不得互相影响。

## System Prompt

`SystemPromptBuilder` 可以同步或异步返回字符串。每次 prompt 开始时都使用当前 model、工具列表、cwd 和当前日期重新构建。

`system-prompt.ts` 只包含通用的 `formatSystemPrompt()` 与 `defaultSystemPrompt()`。`coding-system-prompt.ts` 只导出 `CODING_SYSTEM_PROMPT`。删除没有调用者和组合语义的 `extraContext`。

低层 `HarnessConfig.systemPrompt` 必填，不隐式选择 coding prompt。高层 factory 在调用者没有提供 prompt 时选择 `CODING_SYSTEM_PROMPT`。

## Coding Factory

`factory.ts` 只做装配，不参与运行逻辑，也不使用动态 import：

```ts
export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness> {
  const session =
    config.session ??
    await Session.create(config.project.storageDir);

  const toolRegistry = createToolRegistry(config.project.workDir);
  const systemPrompt = resolveSystemPrompt(config.systemPrompt);

  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry,
    systemPrompt,
    cwd: config.project.workDir,
  });
}
```

`project.workDir` 是唯一 cwd 来源，删除重复的 `CreateHarnessConfig.cwd`。`model` 明确必填；默认 provider/model 由 `ai.createStreamFn()` 返回，Harness 不读取环境变量或再次检测 provider。

传入 `session` 时 factory 不创建新 Session。Session 记录的模型优先于 config 默认模型。

## 公共导出

`src/harness/index.ts` 导出：

核心：

- `AgentHarness`
- `createHarness`
- `HarnessConfig`
- `HarnessProject`
- `CreateHarnessConfig`
- `HarnessEventListener`
- `Unsubscribe`
- `SystemPromptBuilder`
- `SystemPromptContext`

Session：

- `Session`
- `SessionError`
- `SessionContext`
- `SessionErrorCode`

System prompt：

- `formatSystemPrompt`
- `defaultSystemPrompt`
- `CODING_SYSTEM_PROMPT`

Coding tools：

- `createToolRegistry`
- `BashTool`
- `BashOperations`
- `LocalBashOperations`
- `ReadFileTool`
- `WriteFileTool`
- `EditFileTool`
- `GlobTool`
- `TodoWriteTool`
- `TodoItem`

删除以下导出：

- `Hook`
- `HookResult`
- `HookRegistry`
- `createHookRegistry`
- `PermissionHook`
- `getCurrentTodos`

## CLI 集成

CLI 在运行循环开始时订阅一次，在退出时取消：

```ts
const unsubscribe = harness.subscribe((event) => {
  renderAgentEvent(event, writeDelta, writeLine);
});

try {
  await harness.prompt(input);
} finally {
  unsubscribe();
}
```

实际 `CliFrontend.run()` 的订阅覆盖整个 CLI 生命周期，不在每次 prompt 重复注册。ESC 继续调用 `harness.abort()`。

## 文档

实现完成后必须重写 `src/harness/README.md`，并以最终代码和 `harness/index.ts` 为准完整说明：

- 最小创建和订阅用法；
- Harness 的职责与非职责；
- `AgentHarness` 的全部公共方法和 getter；
- `createHarness()` 与低层构造的区别；
- Session 的树结构、恢复和延迟落盘语义；
- system prompt builder；
- 默认 coding tools 和每个公开工具；
- 完整公共导出；
- 对 `ai`、`agent` 和上层 CLI 的依赖方向；
- Harness 不提供 hooks、插件、重试、压缩或分支能力。

README 不写内部逐行算法，也不保留已经删除的 hook、`AsyncIterable` prompt、可选 model 或重复 cwd 等旧描述。

`src/agent/README.md` 中 AgentLoopConfig 固定回调仍属于 agent 包，不应改写成 Harness hooks。只有最终实现确实改变其签名时才同步更新。

## 兼容性与有意破坏

保持：

- 现有 JSONL entry 结构与路径；
- Agent、AI 和 tool 核心协议；
- `createStreamFn()` 返回 `{ stream, defaultModel }`；
- 默认 coding 工具名称；
- CLI 事件渲染函数。

有意破坏：

- `harness.prompt()` 从 AsyncIterable 改为 Promise<void>；
- 删除所有 Harness hook API；
- 删除 `CreateHarnessConfig.cwd`；
- `CreateHarnessConfig.model` 明确必填；
- `Session.appendModelChange(provider, model)` 改为 `appendModelChange(modelConfig)`；
- 删除 `Session.messages()`；
- 删除 `getCurrentTodos()`；
- `createToolRegistry()` 要求显式 cwd；
- system prompt builder 允许返回 Promise。

## 测试要求

### AgentHarness

- 从 Session 恢复历史消息；
- Session 模型优先于默认模型；
- prompt 完整消费 Agent 事件；
- subscribers 按注册顺序执行；
- async subscriber 被等待；
- unsubscribe 生效且幂等；
- subscriber 抛错时 prompt reject；
- subscriber 收到事件前，相应消息已经进入 Session；
- prompt 完成或失败后恢复 idle；
- 并发 prompt 抛 busy；
- 运行中切换模型或修改工具抛 busy；
- abort 结束当前运行；
- switchModel 成功写入 Session；
- Session 写入失败时模型不改变；
- 注册和注销工具影响下一轮 prompt 和 tool schema；
- async system prompt builder 被等待。

### Session

- in-memory Session 不访问文件系统；
- 第一条 assistant 前没有 JSONL；
- 第一条 assistant 一次性写入 buffered entries；
- 后续 entry 逐条追加；
- open 恢复消息、模型和 leaf；
- 当前分支按 parentId 重建；
- 不存在、空、无效 JSON 和无效 entry 返回正确错误；
- 非法 session ID 被拒绝；
- 持久化失败时回滚 entry 和 leaf；
- `buildContext()` 返回副本。

### Coding 能力

- factory 使用 `project.workDir`；
- factory 使用传入 Session；
- 默认 prompt 来自 `CODING_SYSTEM_PROMPT`；
- 字符串 prompt 正确格式化 cwd/date；
- 异步 builder 正常工作；
- Bash 危险规则全部在 BashTool 生效；
- 被阻止的 Bash 不调用执行后端；
- TodoWriteTool 实例状态隔离；
- 默认运行不再输出 hook console 日志。

### 全量验证

实现完成后以 `package.json` 实际脚本为准运行测试、类型检查和 lint，并记录不存在或跳过的脚本。
