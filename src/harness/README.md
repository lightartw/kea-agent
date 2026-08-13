# Harness — Agent 运行时

Harness 是拥有 Agent 生命周期的单线程运行时核心。它在内部消费 `AgentEvent`，将稳定消息持久化到树形 `Session` 中，并将已持久化的事件发布给等待中的订阅者。

## 最小用法

```ts
import { createStreamFn } from "./ai/factory.js";
import { createHarness } from "./coding-agent/factory.js";
import { Session } from "./agent/harness/session/session.js";

const { stream, defaultModel } = createStreamFn();

const project = { workDir: process.cwd(), storageDir: ".kea/sessions" };
const session = await Session.create(project.storageDir);

const harness = await createHarness({
  project,
  streamFn: stream,
  model: defaultModel,
  session,
});

harness.subscribe((event) => {
  // 渲染事件（text_delta、tool_start 等）
});

await harness.prompt("Write a hello-world program.");
```

## 概念

Harness 分为三层：

- **Session 管理层**（`SessionManager`）：管理一个 project 下多个 `Session` 文件的生命周期。负责 session 的列出和恢复；创建/打开单个 session 由 `Session.create()`/`Session.open()` 负责。
- **通用运行时**（`AgentHarness`）：持有 Agent、Session 和监听器。消费 Agent 事件、持久化消息并发布给订阅者。绝不导入具体 coding 工具或 coding system prompt。
- **Coding 组合**（`createHarness`）：将 `AgentHarness` 与 coding 工具集、coding system prompt 和 Hook 组装在一起的工厂函数。这是唯一导入具体工具和 `CODING_SYSTEM_PROMPT` 的文件。`session` 和 `model` 由调用方传入。

## `SessionManager`

管理一个 project（`cwd` → `storageDir` 映射）下所有 session JSONL 文件的生命周期。

```ts
class SessionManager {
  constructor(project: HarnessProject);
  continueRecent(): Promise<Session>;
  listSessions(): Promise<string[]>;
}
```

### 方法

| 方法 | 描述 |
|------|------|
| `continueRecent(): Promise<Session>` | 打开最近修改的 session；若无则创建新 session。 |
| `listSessions(): Promise<string[]>` | 返回所有 session ID，按修改时间倒序。 |

### 行为细节

- `listSessions()` 只识别匹配 `^[A-Za-z0-9_-]+\.jsonl$` 的文件，忽略隐藏文件和非法文件名；当 `sessions/` 目录尚不存在时返回 `[]`。
- `continueRecent()` 内部调用 `listSessions()` 取最新，空目录时 fallback 到 `Session.create()`。

## `AgentHarness`

核心类。通过 `HarnessConfig` 构造：

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
  readonly hooks?: AgentHookTrigger;
}
```

### Hook 透传

- `hooks` 为可选 `AgentHookTrigger`；未传入时使用空 Registry。
- Harness 将同一个 trigger 直接传给 Agent Loop，不重新包装或定义新的事件。
- Harness 不建立自己的 Hook 事件、第二个 dispatcher 或 ExtensionHost。
- `subscribe()` 返回的观察者只能接收 `AgentEvent`，不能控制运行。

### 两条通道

| 通道 | 接口 | 用途 |
|------|------|------|
| 观察 | `subscribe(listener)` → `AgentEvent` | 渲染、日志；返回值被忽略 |
| 控制 | `HarnessConfig.hooks` → `AgentHookTrigger` | 阻止/转换/修补/续跑 |

二者不是两套同义回调——`subscribe` 的返回值被忽略，只能观察运行事实；Hook 在动作提交前触发，只有调用定义的结果可以阻止、转换、修补或续跑。

`subscribe()` 交付的是**已经持久化的最终事实**：`prompt()` 在发布每个事件前先调用
`persistNewMessages()`，因此订阅者读到 `tool_end` / `tool_rejected` 时，对应的
`ToolResultMessage` 已经在 Session 里。Harness 没有 `HarnessUI` 反向接口——UI 通过
`subscribe` 消费事实，Hook 通过 `HarnessConfig.hooks` 向下注入以控制 Agent，两条方向
互不经过对方。

### 方法

| 方法 | 描述 |
|------|------|
| `prompt(input: string): Promise<void>` | 运行一次 agent 轮次。将消息持久化到 Session 并将 Agent 事件发布给所有订阅者。轮次完成后 resolve。 |
| `subscribe(listener: HarnessListener): Unsubscribe` | 注册一个监听器。返回用于移除该监听器的函数。 |
| `abort(): void` | 请求中止正在运行的 prompt。空闲时无操作。 |
| `switchModel(model: ModelConfig): Promise<void>` | 持久化模型变更并更新当前模型。仅空闲时允许调用。 |
| `registerTool(tool: AgentTool): void` | 为下一次运行注册工具。仅空闲时允许调用。 |
| `unregisterTool(name: string): void` | 移除工具。仅空闲时允许调用。 |

### Getter

| Getter | 描述 |
|--------|------|
| `messages: readonly AgentMessage[]` | Agent 的当前对话历史。 |
| `model: ModelConfig` | 当前模型配置。 |
| `isRunning: boolean` | 是否有 prompt 正在运行。 |

### 空闲期变异约束

当 `isRunning` 为 `true` 时，`switchModel()`、`registerTool()` 和 `unregisterTool()` 会抛出异常。运行时调用 `prompt()` 同样会被拒绝。

## `createHarness`

Coding agent 的组合根。定义在 `coding-agent/factory.ts`，其配置类型 `CreateHarnessConfig` 属于 `coding-agent` 包。

```ts
interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly ui?: CodingHookUI;
}

interface HarnessProject {
  readonly workDir: string;     // 工具 cwd + prompt 变量
  readonly storageDir: string;  // session JSONL 目录
}
```

- `model` 为必填项。provider/default-model 的选择由 `ai.createStreamFn()` 处理。
- `session` 为必填项。Session 的创建职责属于 `Session.create()`，`createHarness` 只负责组装。
- 若 `systemPrompt` 为字符串，则通过 `defaultSystemPrompt()` 包装，支持 `{{cwd}}`/`{{date}}` 替换。
- 若 `systemPrompt` 为函数，则直接作为 `SystemPromptBuilder` 使用。
- 若省略 `systemPrompt`，则默认使用 `CODING_SYSTEM_PROMPT`。
- `ui` 可选；未传入时使用内部 `NO_HOOK_UI`（fail-closed）。

### 典型调用链

```ts
const project = { workDir: process.cwd(), storageDir: "~/.kea/projects/..." };
const session = await Session.create(project.storageDir);
const harness = await createHarness({ project, streamFn, model, session, ui: cli });
```

## Session

基于树的 JSONL 持久化，延迟首次写入。

### 工厂方法

| 工厂方法 | 描述 |
|----------|------|
| `Session.create(storageDir: string): Promise<Session>` | 创建具有随机 ID 的新 session。 |
| `Session.open(storageDir: string, sessionId: string): Promise<Session>` | 从磁盘重新打开 session。 |
| `Session.inMemory(): Session` | 用于测试的临时 session。 |

> **注意：** 应用层直接调用 `Session.create()`/`Session.open()` 创建或恢复单个 session；`SessionManager.continueRecent()` 用于「恢复最近一次会话」。`Session.inMemory()` 在测试中直接使用。

### API

| 方法 | 描述 |
|------|------|
| `appendMessage(message: AgentMessage): Promise<void>` | 将消息追加到树中。追加操作内部序列化。 |
| `appendModelChange(model: ModelConfig): Promise<void>` | 记录模型变更条目。 |
| `buildContext(): SessionContext` | 按当前叶节点父链返回 `{ messages, model }`。返回的数组是全新副本。 |

### 持久化

- 消息在内存中缓冲，直到第一条 assistant 消息被追加。
- 第一条 assistant 消息通过 `writeFile(path, lines, { flag: "wx" })` 创建 JSONL 文件。
- 后续追加使用 `appendFile()`。
- 写入失败时，条目及其树链接会被回滚。
- `Session.open()` 校验每一行：ENOENT → `not_found`，空文件/JSON 语法错误 → `invalid_session`，未知/格式错误条目 → `invalid_entry`。

### SessionContext

```ts
interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}
```

### SessionError

```ts
type SessionErrorCode = "not_found" | "invalid_session" | "invalid_entry" | "storage";

class SessionError extends Error {
  readonly code: SessionErrorCode;
}
```

## System Prompt

### `SystemPromptBuilder`

```ts
interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

type SystemPromptBuilder = (ctx: SystemPromptContext) => string | Promise<string>;
```

`SystemPromptBuilder` 可以是异步的。`AgentHarness` 在每次运行前 await 它。

### 辅助函数

| 函数 | 描述 |
|------|------|
| `formatSystemPrompt(content, options?)` | 替换 `{{cwd}}` 和 `{{date}}` 占位符。 |
| `defaultSystemPrompt(template)` | 将模板字符串包装为 `SystemPromptBuilder`。 |
| `CODING_SYSTEM_PROMPT` | 带有 `{{cwd}}` 和 `{{date}}` 的默认 coding agent prompt。 |

## 完整公开导出

从 `src/agent/harness/index.ts`：

- `AgentHarness`、`Session`、`SessionError`、`SessionManager`
- `defaultSystemPrompt`、`formatSystemPrompt`
- `HarnessConfig`、`HarnessListener`、`HarnessProject`
- `SystemPromptBuilder`、`SystemPromptContext`、`Unsubscribe`
- `SessionContext`、`SessionErrorCode`

## 明确不提供的功能

Harness 明确**不**提供：

- Harness 专属 Hook 事件 — Hook 事件由 Agent 层定义，Harness 只透传 `AgentHookTrigger`。
- 第二个 Hook dispatcher 或 ExtensionHost。
- EventBus — 订阅者是 Harness 实例上的直接监听器。
- 重试、压缩、分支 API。
- 除 `SystemPromptBuilder` 之外的 skills 或 prompt 模板。
- 队列 — session 追加操作内部序列化但不对外暴露。

`CreateHarnessConfig` 属于 `coding-agent`，不属于通用 Harness。Harness 运行时文件（`agent-harness.ts`、`types.ts`、`system-prompt.ts`、`session/`）绝不导入具体 coding 工具或 `CODING_SYSTEM_PROMPT`。仅 `coding-agent/factory.ts` 组合这些默认值。
