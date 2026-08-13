# Harness — Agent 运行时

Harness 是拥有 Agent 生命周期的单线程运行时核心。它在内部消费 `AgentEvent`，把每个事件
提升为 `HarnessEvent`（附 `lane` 与 `runId`），将稳定消息持久化到树形 `Session` 中，
并通过唯一的事件流发布给订阅者。它是运行时对外唯一的观察与控制面。

## 最小用法

```ts
import { createStreamFn } from "../ai/factory.js";
import { createCodingAgent } from "../coding-agent/factory.js";
import { Session } from "./session/session.js";

const { stream, defaultModel } = createStreamFn();
const project = { workDir: process.cwd(), storageDir: ".kea/sessions" };
const session = await Session.create(project.storageDir);

const runtime = await createCodingAgent({
  project,
  streamFn: stream,
  model: defaultModel,
  session,
});

runtime.harness.subscribe((event) => {
  // 渲染 HarnessEvent（text_delta、tool_start、run_end 等）
});

await runtime.harness.prompt("Write a hello-world program.");
```

## 概念

Harness 分为三层：

- **Session 管理层**（`SessionManager`）：管理一个 project 下多个 `Session` 文件的生命周期。负责 session 的列出和恢复；创建/打开单个 session 由 `Session.create()`/`Session.open()` 负责。
- **通用运行时**（`AgentHarness`）：持有 Agent、Session 和事件总线。消费 Agent 事件、持久化消息并发布给订阅者。绝不导入具体 coding 工具或 coding system prompt。
- **Coding 组合**（`createCodingAgent`）：将 `AgentHarness` 与 coding 工具定义、coding system prompt、Hook 和 presentation 组装在一起的工厂函数，返回 `CodingAgentRuntime`。`session` 和 `model` 由调用方传入。

## 事件流

`AgentHarness` 对外只发布**一个平坦的 `HarnessEvent` 流**，不暴露内部 Agent 或第二套 Agent 事件订阅：

```ts
type HarnessEvent =
  | LiftAgentEvent          // 每个 AgentEvent 提升后附 lane/runId
  | HarnessOwnedEvent       // run_start / run_end（completed|aborted|error）
```

- 每次 `prompt()` 生成一个 `runId`，当前唯一 lane 为 `main`（`MAIN_LANE`）。
- 订阅者读到 `tool_end` / `tool_rejected` 时，对应的 `ToolResultMessage` 已经在 Session 里（先持久化、后发布）。
- 事件监听器失败被隔离：单个监听器抛错不会拒绝 `prompt()`，也不会阻止后续监听器收到 `run_end`。诊断通过 `HarnessConfig.onEventListenerError` 上报。

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
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}
```

### 两条通道

| 通道 | 接口 | 用途 |
|------|------|------|
| 观察 | `subscribe(listener)` → `HarnessEvent` | 渲染、日志；返回值被忽略 |
| 控制 | `HarnessConfig.hooks` → `AgentHookTrigger` | 阻止/转换/修补/续跑 |

二者不是两套同义回调——`subscribe` 的返回值被忽略，只能观察运行事实；Hook 在动作提交前触发，只有调用定义的结果可以阻止、转换、修补或续跑。Harness 没有 `HarnessUI` 反向接口——UI 通过 `subscribe` 消费事实，Hook 通过 `HarnessConfig.hooks` 向下注入以控制 Agent，两条方向互不经过对方。

### 方法

| 方法 | 描述 |
|------|------|
| `prompt(input: string): Promise<void>` | 运行一次 agent 轮次，发布 `run_start` → 提升的 `AgentEvent` → `run_end`。轮次完成后 resolve。 |
| `subscribe(listener: HarnessListener): Unsubscribe` | 注册一个监听器。返回用于移除该监听器的函数。 |
| `abort(): void` | 请求中止正在运行的 prompt。空闲时无操作。 |
| `switchModel(model: ModelConfig): Promise<void>` | 持久化模型变更并更新当前模型。仅空闲时允许调用。 |
| `registerTool(tool: AgentTool): void` | 为下一次运行注册工具。仅空闲时允许调用。 |
| `unregisterTool(name: string): void` | 移除工具。仅空闲时允许调用。 |

### Getter 与空闲期约束

- `messages: readonly AgentMessage[]`、`model: ModelConfig`、`isRunning: boolean`。
- 当 `isRunning` 为 `true` 时，`switchModel()`、`registerTool()` 和 `unregisterTool()` 会抛出异常。

## `SessionManager`

管理一个 project（`cwd` → `storageDir` 映射）下所有 session JSONL 文件的生命周期。

```ts
class SessionManager {
  constructor(project: HarnessProject);
  continueRecent(): Promise<Session>;
  listSessions(): Promise<string[]>;
}
```

- `listSessions()` 只识别匹配 `^[A-Za-z0-9_-]+\.jsonl$` 的文件，忽略隐藏文件和非法文件名；当 `sessions/` 目录尚不存在时返回 `[]`。
- `continueRecent()` 内部调用 `listSessions()` 取最新，空目录时 fallback 到 `Session.create()`。

## Session

基于树的 JSONL 持久化，延迟首次写入。

### 工厂方法

| 工厂方法 | 描述 |
|----------|------|
| `Session.create(storageDir: string): Promise<Session>` | 创建具有随机 ID 的新 session。 |
| `Session.open(storageDir: string, sessionId: string): Promise<Session>` | 从磁盘重新打开 session。 |
| `Session.inMemory(): Session` | 用于测试的临时 session。 |

### API 与持久化

- `appendMessage(message: AgentMessage): Promise<void>`：追加到树中，内部序列化。
- `appendModelChange(model: ModelConfig): Promise<void>`：记录模型变更条目。
- `buildContext(): SessionContext`：按当前叶节点父链返回 `{ messages, model }`，返回全新副本。
- 消息在内存缓冲直到第一条 assistant message；首次 flush 用 `writeFile(…, "wx")` 原子创建，后续追加写；写入失败回滚内存 entry 和 leaf。
- `open()` 校验 JSON、entry 结构、重复 ID、父引用、根数量、消息字段（含 `details` 的 JSON-safe 校验）。

### SessionContext / SessionError

```ts
interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}

type SessionErrorCode = "not_found" | "invalid_session" | "invalid_entry" | "storage";
class SessionError extends Error { readonly code: SessionErrorCode; }
```

## System Prompt

```ts
type SystemPromptBuilder = (ctx: SystemPromptContext) => string | Promise<string>;
interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}
```

辅助函数：`formatSystemPrompt(content, options?)` 替换 `{{cwd}}`/`{{date}}`；`defaultSystemPrompt(template)` 包装模板为 `SystemPromptBuilder`。

## 完整公开导出

从 `src/harness/index.ts`：

- `AgentHarness`、`Session`、`SessionError`、`SessionManager`
- `defaultSystemPrompt`、`formatSystemPrompt`
- `HarnessConfig`、`HarnessProject`、`SystemPromptBuilder`、`SystemPromptContext`
- `SessionContext`、`SessionErrorCode`
- `HarnessEvent`、`HarnessToolEvent`、`HarnessListener`、`HarnessListenerErrorHandler`
- `HarnessEventBus`、`MAIN_LANE`、`liftAgentEvent`、`Unsubscribe`

## 明确不提供的功能

Harness 明确**不**提供：

- Harness 专属 Hook 事件 — Hook 事件由 Agent 层定义，Harness 只透传 `AgentHookTrigger`。
- 第二个 Hook dispatcher 或 ExtensionHost。
- 非 `main` 的 lane（当前唯一实现 lane 为 `main`；不声称支持 background/parallel lanes）。
- 重试、压缩、分支 API、snapshot/watch。
- 除 `SystemPromptBuilder` 之外的 skills 或 prompt 模板。
- 队列 — session 追加操作内部序列化但不对外暴露。

`CreateCodingAgentConfig` 属于 `coding-agent`，不属于通用 Harness。Harness 运行时文件（`agent-harness.ts`、`types.ts`、`system-prompt.ts`、`events/`、`session/`）绝不导入具体 coding 工具或 `CODING_SYSTEM_PROMPT`。仅 `coding-agent/factory.ts` 组合这些默认值。
