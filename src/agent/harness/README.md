# Harness — Agent 运行时

Harness 是拥有 Agent 生命周期的单线程运行时核心。它在内部消费 `AgentEvent`，将稳定消息持久化到树形 `Session` 中，并将已持久化的事件发布给等待中的订阅者。

## 最小用法

```ts
import { createStreamFn } from "./ai/factory.js";
import { createHarness } from "./coding-agent/factory.js";
import { SessionManager } from "./agent/harness/session/manager.js";

const { stream, defaultModel } = createStreamFn();

const project = { workDir: process.cwd(), storageDir: ".kea/sessions" };
const sessionManager = await SessionManager.create(project);
const session = await sessionManager.createSession();

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

- **Session 管理层**（`SessionManager`）：管理一个 project 下多个 `Session` 文件的生命周期。负责 session 的创建、打开、列出和恢复。
- **通用运行时**（`AgentHarness`）：持有 Agent、Session 和监听器。消费 Agent 事件、持久化消息并发布给订阅者。绝不导入具体 coding 工具或 coding system prompt。
- **Coding 组合**（`createHarness`）：将 `AgentHarness` 与 coding 工具集、coding system prompt 组装在一起的工厂函数。这是唯一导入具体工具和 `CODING_SYSTEM_PROMPT` 的文件。`session` 由调用方传入（必传）。

## `SessionManager`

管理一个 project（`cwd` → `storageDir` 映射）下所有 session JSONL 文件的生命周期。

### 工厂方法

| 工厂方法 | 描述 |
|----------|------|
| `SessionManager.create(project: HarnessProject): Promise<SessionManager>` | 确保 `storageDir/sessions/` 目录存在，返回 manager 实例。 |

### 方法

| 方法 | 描述 |
|------|------|
| `createSession(): Promise<Session>` | 始终创建新 session。 |
| `openSession(sessionId: string): Promise<Session>` | 按 ID（文件名去掉 `.jsonl`）打开已有 session。 |
| `continueRecent(): Promise<Session>` | 打开最近修改的 session；若无则创建新 session。 |
| `listSessions(): Promise<string[]>` | 返回所有 session ID，按修改时间倒序。 |

### 行为细节

- `listSessions()` 只识别匹配 `^[A-Za-z0-9_-]+\.jsonl$` 的文件，忽略隐藏文件和非法文件名。
- `continueRecent()` 内部调用 `listSessions()` 取最新，空目录时 fallback 到 `createSession()`。

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
}
```

### 方法

| 方法 | 描述 |
|------|------|
| `prompt(input: string): Promise<void>` | 运行一次 agent 轮次。将消息持久化到 Session 并将 Agent 事件发布给所有订阅者。轮次完成后 resolve。 |
| `subscribe(listener: HarnessEventListener): Unsubscribe` | 注册一个监听器。返回用于移除该监听器的函数。 |
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

Coding agent 的组合根：

```ts
interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;           // 必填
  readonly session: Session;             // 必填，由调用方通过 SessionManager 创建
  readonly systemPrompt?: string | SystemPromptBuilder;
}

interface HarnessProject {
  readonly workDir: string;     // 工具 cwd + prompt 变量
  readonly storageDir: string;  // session JSONL 目录
}
```

- `model` 为必填项。provider/default-model 的选择由 `ai.createStreamFn()` 处理。
- `session` 为必填项。Session 的创建职责属于 `SessionManager`，`createHarness` 只负责组装。
- 若 `systemPrompt` 为字符串，则通过 `defaultSystemPrompt()` 包装，支持 `{{cwd}}`/`{{date}}` 替换。
- 若 `systemPrompt` 为函数，则直接作为 `SystemPromptBuilder` 使用。
- 若省略 `systemPrompt`，则默认使用 `CODING_SYSTEM_PROMPT`。

### 典型调用链

```ts
const project = { workDir: process.cwd(), storageDir: "~/.kea/projects/..." };
const sessionManager = await SessionManager.create(project);
const session = await sessionManager.createSession();
const harness = await createHarness({ project, streamFn, model, session });
```

## Session

基于树的 JSONL 持久化，延迟首次写入。

### 工厂方法

| 工厂方法 | 描述 |
|----------|------|
| `Session.create(storageDir: string): Promise<Session>` | 创建具有随机 ID 的新 session。 |
| `Session.open(storageDir: string, sessionId: string): Promise<Session>` | 从磁盘重新打开 session。 |
| `Session.inMemory(): Session` | 用于测试的临时 session。 |

> **注意：** 应用层通常通过 `SessionManager` 间接使用这些工厂方法，而非直接调用。`Session.inMemory()` 在测试中仍然直接使用。

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

## 工具

### `createToolRegistry(cwd: string): AgentToolRegistry`

按注册顺序创建包含默认工具集的 registry：

1. `BashTool(cwd)` — shell 命令执行
2. `ReadFileTool(cwd)` — 读取文件
3. `WriteFileTool(cwd)` — 创建/覆写文件
4. `EditFileTool(cwd)` — 精确字符串替换
5. `GlobTool(cwd)` — 文件通配符匹配
6. `TodoWriteTool()` — 任务列表管理

### `BashTool`

- 拥有唯一的权威 Bash 安全策略。
- 阻止包含禁止片段的命令：`rm `、`rm -rf /`、`sudo`、`chmod 777`、`shutdown`、`reboot`、`mkfs`、`dd `、`> /etc/`、`> /dev/`。
- 对被阻止的命令返回 `{ content: "Error: Permission denied: <reason>", isError: true }`。
- 策略检查在调用执行后端之前运行。
- `BashOperations` 接口允许替换后端（默认：`LocalBashOperations`）。

### `TodoWriteTool`

- Todo 状态为实例私有。两个 `TodoWriteTool` 实例的状态相互独立。
- 无全局访问器。状态仅通过工具自身的 `execute()` 访问。

### 其他工具

- `ReadFileTool`、`WriteFileTool`、`EditFileTool` — 限定在工作区内的文件操作。
- `GlobTool` — 返回相对于工作区的匹配结果。

## 包边界

### 导入（来自 AI/Agent 层）

```ts
// 从 Agent 层消费的类型
import type { AgentEvent, AgentMessage } from "../agent/types.js";
import type { AgentTool, AgentToolResult } from "../agent/tools/types.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";

// 从 AI 层消费的类型
import type { ModelConfig, StreamFn } from "../ai/types.js";
```

### 导出（面向 CLI）

```ts
// 类
export { AgentHarness } from "./agent-harness.js";
export { BashTool } from "./tools/bash.js";
export { LocalBashOperations } from "./tools/bash-ops.js";
export { ReadFileTool, WriteFileTool, EditFileTool } from "./tools/files.js";
export { GlobTool } from "./tools/glob.js";
export { TodoWriteTool } from "./tools/todo-write.js";
export { Session } from "./session/session.js";
export { SessionError } from "./session/types.js";
export { SessionManager } from "./session/manager.js";

// 工厂函数
export { createHarness } from "./factory.js";
export { createToolRegistry } from "./tools/factory.js";

// Prompt
export { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
export { defaultSystemPrompt, formatSystemPrompt } from "./system-prompt.js";

// 类型
export type { CreateHarnessConfig, HarnessConfig, HarnessEventListener,
  HarnessProject, SystemPromptBuilder, SystemPromptContext,
  Unsubscribe } from "./types.js";
export type { SessionContext, SessionErrorCode } from "./session/types.js";
export type { BashOperations } from "./tools/bash.js";
export type { TodoItem } from "./tools/todo-write.js";
```

## 明确不提供的功能

Harness 明确**不**提供：

- Hook 或插件 — Hook 子系统已移除。
- EventBus — 订阅者是 Harness 实例上的直接监听器。
- 重试、压缩、分支 API。
- 除 `SystemPromptBuilder` 之外的 skills 或 prompt 模板。
- 队列 — session 追加操作内部序列化但不对外暴露。

Harness 运行时文件（`agent-harness.ts`、`types.ts`、`system-prompt.ts`、`session/`）绝不导入具体 coding 工具或 `CODING_SYSTEM_PROMPT`。仅 `factory.ts` 组合这些默认值。
