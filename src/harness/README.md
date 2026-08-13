# Harness — 管理 Agent 的一次次运行

Agent 负责完成一项任务：接收消息、请求模型、执行工具，直到本次任务结束。

真正的应用还需要记住历史、切换模型、中止运行，并把运行过程交给 UI 或日志系统。`harness`
包负责这些工作。它在 Agent 外面增加了**运行管理、会话保存和事件通知**，但不知道 Bash、
TodoWrite 等具体 coding 工具，也不包含 UI。

可以先记住这组关系：

- Agent 决定一次任务怎样执行；
- Harness 管理任务何时开始和结束，并保存结果；
- 上层应用订阅 Harness 事件，再决定怎样展示结果。

## 最小用法

下面创建一个只保存在内存中的 Harness，监听文本输出，然后运行一次任务：

```ts
import { createStreamFn } from "../ai/factory.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import {
  AgentHarness,
  Session,
  defaultSystemPrompt,
} from "./index.js";

const { stream, defaultModel } = createStreamFn();

const harness = new AgentHarness({
  session: Session.inMemory(),
  model: defaultModel,
  streamFn: stream,
  toolRegistry: new AgentToolRegistry(),
  systemPrompt: defaultSystemPrompt("You are a helpful assistant."),
  cwd: process.cwd(),
});

const unsubscribe = harness.subscribe((event) => {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
});

await harness.prompt("Explain what an event is.");
unsubscribe();
```

通常，Coding Agent 不会手动完成这些组装工作，而是调用 `createCodingAgent()` 获得已经配置好
工具、Hook 和 system prompt 的 Harness。但无论怎样创建，运行和订阅方式都相同。

## 一次 `prompt()` 发生了什么

调用：

```ts
await harness.prompt("Create hello.txt");
```

Harness 会按以下顺序工作：

1. 根据当前模型、工具、工作目录和日期生成 system prompt。
2. 创建本次运行的 `runId`，发布 `run_start`。
3. 启动 Agent。Agent 产生文本、工具调用和工具结果等事件。
4. Agent 产生的新消息先写入 Session，然后 Harness 再向订阅者发布对应事件。
5. 运行完成、中止或失败后，Harness 发布一个 `run_end`。

所以 `prompt()` 不只是“问一次模型”。一次运行中可能包含多个模型请求和多个工具调用。
`prompt()` 在整个运行结束后才会完成。`run_start` 发布后发生的失败会产生
`run_end: error`，随后由 `prompt()` 抛出；如果 system prompt 生成失败，运行尚未开始，
因此不会产生这对运行事件。

## Event Bus：把运行事实通知给上层

Event Bus 可以译为“事件总线”。这里的“总线”不是特殊线程，它只是保存一组 listener，
并在新事件出现时依次调用它们。

理解它只需要四个概念：

| 概念 | 含义 |
|------|------|
| Event | 描述已经发生之事的普通对象，例如 `{ type: "run_start" }`。 |
| Listener | 接收 Event 的函数，常用于更新 UI 或写日志。 |
| `subscribe()` | 把 Listener 登记到 Event Bus。 |
| `publish()` | 把一个 Event 依次交给所有 Listener。 |

`AgentHarness` 内部拥有一个 `HarnessEventBus`。使用 Harness 时通常只需要调用
`harness.subscribe()`，不需要自己调用 `publish()`：

```ts
const unsubscribe = harness.subscribe(async (event) => {
  console.log(event.type, event.runId);
});

await harness.prompt("Hello");
unsubscribe(); // 此后不再接收事件
```

一次简单运行可能让 Listener 依次收到：

```text
run_start
agent_start
turn_start
text_delta
turn_end
agent_end
run_end
```

如果模型调用工具，中间还会出现 `toolcall_*`、`tool_start`、`tool_end` 或
`tool_rejected`。

### Event Bus 的行为约定

- 一个 Harness 只有一条 `HarnessEvent` 流。
- Listener 按注册顺序执行；异步 Listener 也会被等待。
- `subscribe()` 返回的 `unsubscribe()` 可以安全地重复调用。
- 发布一个 Event 时使用当时的 Listener 快照；订阅变化从下一个 Event 开始生效。
- Listener 的返回值会被忽略，因此 Listener 不能改变 Agent 的决定。
- 某个 Listener 抛错不会中断运行，也不会阻止其他 Listener。错误交给
  `HarnessConfig.onEventListenerError`。

这些约定让 UI 或日志代码出错时，不会破坏 Agent 的主要运行流程。

## `HarnessEvent` 包含什么

`HarnessEvent` 是 Harness 对外发布的唯一事件类型，由两部分组成：

1. Harness 自己产生的 `run_start` 和 `run_end`；
2. Agent 产生的 `AgentEvent`，由 Harness 加上 `runId` 和 `lane` 后继续发布。

主要事件如下：

| 阶段 | Event `type` | 表示的事实 |
|------|--------------|------------|
| Harness 运行 | `run_start`、`run_end` | 一次 `prompt()` 开始或结束。 |
| Agent 运行 | `agent_start`、`agent_end` | Agent Loop 开始或结束。 |
| 模型请求 | `turn_start`、`turn_end` | 一次模型请求开始或结束。 |
| 流式内容 | `text_delta`、`thinking_delta` | 模型刚产生一段文本或思考内容。 |
| 工具调用生成 | `toolcall_start`、`toolcall_delta`、`toolcall_end` | 模型正在生成一个工具调用。 |
| 工具执行 | `tool_start`、`tool_end`、`tool_rejected` | 工具开始、结束，或在执行前被拒绝。 |

`run_end.reason` 为 `completed`、`aborted` 或 `error`。发生错误时，事件还包含
`errorMessage`。

`HarnessToolEvent` 只是从 `HarnessEvent` 中提取三个工具执行事件得到的 TypeScript
类型，方便工具展示代码限制自己的输入。它不是第二条事件流，也没有独立的 Event Bus。

## `runId` 和 `lane`

每个 `HarnessEvent` 都有：

```ts
interface HarnessEventContext {
  readonly runId: string;
  readonly lane: string;
}
```

`runId` 是一次 `prompt()` 的唯一编号。同一次运行产生的所有事件拥有相同的 `runId`；
下一次 `prompt()` 会得到新编号。UI 和日志可以据此把事件归入正确的一次运行。

`lane` 表示事件属于哪个运行通道。当前 Harness 只实现一个通道，值始终为 `main`
（常量 `MAIN_LANE`）。它现在不表示并发能力；消费者只需保存或读取这个字段，不应假设
已经存在后台通道。

## Event 和 Hook 为什么不能互相替代

Event 用来报告事实，Hook 用来影响尚未完成的动作：

| | Event / `subscribe()` | Hook / `trigger()` |
|---|---|---|
| 发生时间 | 动作已经发生后 | 动作提交前或可转换的阶段 |
| 返回值 | 忽略 | 按 Hook 契约处理 |
| 典型用途 | UI、日志、统计 | 权限判断、修改上下文、调整工具结果 |
| 出错影响 | Listener 错误被隔离 | Hook 错误可能阻止或改变运行 |

当前 Harness 通过 `HarnessConfig.hooks` 接收 Agent 层的 `AgentHookTrigger`，再将它用于
Agent 运行。Harness 目前没有自己的 Hook Call 类型或第二个 Hook Registry。

## Session：保存消息和模型选择

Session 是 Harness 的持久状态。没有 Session，下一次运行就不知道此前说过什么、使用的是
哪个模型。

Harness 创建时读取：

```ts
interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}
```

运行期间产生的新消息和模型切换会继续写回同一个 Session。

### 创建和恢复

| 方法 | 用途 |
|------|------|
| `Session.create(storageDir)` | 创建一个会写入磁盘的新 Session。 |
| `Session.open(storageDir, sessionId)` | 从磁盘恢复指定 Session。 |
| `Session.inMemory()` | 创建不写入磁盘的 Session，适合测试。 |

Session 在磁盘上使用 JSONL 树结构保存记录，目前消息沿一条直线追加。磁盘文件在出现第一条
assistant message 时创建；写入失败时，对应的内存记录也会回滚。

### Session API

| 方法 | 用途 |
|------|------|
| `appendMessage(message)` | 追加一条 Agent 消息。 |
| `appendModelChange(model)` | 记录一次模型切换。 |
| `buildContext()` | 沿当前分支生成新的消息数组和最新模型。 |

`SessionError.code` 可以是 `not_found`、`invalid_session`、`invalid_entry` 或 `storage`。

### 管理一个项目中的多个 Session

`SessionManager` 根据项目配置列出和恢复 Session：

```ts
interface HarnessProject {
  readonly workDir: string;
  readonly storageDir: string;
}

const manager = new SessionManager(project);
const ids = await manager.listSessions();    // 按最近修改时间排序
const session = await manager.continueRecent(); // 没有历史时自动创建
```

## 创建 `AgentHarness`

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

| 字段 | 来源 | 作用 |
|------|------|------|
| `session` | harness | 保存消息和模型变化；其中已有模型优先于 `model`。 |
| `model` | ai | Session 没有保存模型时使用的初始模型。 |
| `streamFn` | ai | 向指定 provider/model 发起一次流式请求。 |
| `toolRegistry` | agent | 保存 Agent 当前可以执行的工具。 |
| `systemPrompt` | harness | 每次运行前生成 system prompt。 |
| `cwd` | 应用传入 | 提供给 system prompt 的工作目录。 |
| `hooks` | agent，可选 | 控制 Agent 行为；未提供时使用空 Registry。 |
| `onEventListenerError` | harness，可选 | 接收被 Event Bus 隔离的 Listener 错误。 |

### System prompt

`SystemPromptBuilder` 每次运行前接收当前环境，因此模型或工具变化会反映到下一次运行：

```ts
type SystemPromptBuilder = (
  context: {
    model: ModelConfig;
    tools: readonly AgentTool[];
    cwd: string;
    date: Date;
  },
) => string | Promise<string>;
```

`defaultSystemPrompt(template)` 将普通模板包装为 Builder；`formatSystemPrompt()` 可以替换
模板中的 `{{cwd}}` 和 `{{date}}`。

## `AgentHarness` 的方法和状态

| 成员 | 作用 |
|------|------|
| `prompt(input): Promise<void>` | 开始一次完整运行。 |
| `subscribe(listener): Unsubscribe` | 订阅 `HarnessEvent`。 |
| `abort(): void` | 请求中止当前运行；空闲时无操作。 |
| `switchModel(model): Promise<void>` | 保存并切换模型。 |
| `registerTool(tool): void` | 注册下一次运行可用的工具。 |
| `unregisterTool(name): void` | 移除工具。 |
| `messages` | 当前 Session 分支的只读消息列表。 |
| `model` | 当前模型。 |
| `isRunning` | 是否正在处理一次 `prompt()`。 |

Harness 同一时间只运行一个 `prompt()`。运行期间再次调用 `prompt()`、切换模型或修改工具，
都会抛出 `AgentHarness is busy`。`abort()` 是运行期间允许使用的控制操作。

## 包边界

Harness 使用下层提供的定义，但不重新定义它们：

| 概念 | 定义它的包 | Harness 如何使用 |
|------|------------|------------------|
| `ModelConfig`、`StreamFn` | ai | 选择模型并请求 provider。 |
| `AgentMessage`、`AgentEvent` | agent | 保存 Agent 消息并提升 Agent 事件。 |
| `AgentTool`、`AgentToolRegistry` | agent | 提供 Agent 可以执行的工具。 |
| `AgentHookTrigger` | agent | 将控制能力交给 Agent Loop。 |
| Session、运行身份、`HarnessEvent` | harness | 管理跨运行状态并对外发布事实。 |

Coding Agent 位于 Harness 之上，负责组装 coding 工具、Hook 和展示定义。UI 接收组装后的
`CodingAgentRuntime`：从 `runtime.harness` 订阅运行事件，需要展示工具输出时再调用
`runtime.renderToolEvent(event)`。Harness 本身不依赖 Coding Agent 或 UI。

## 完整公开 API

`src/harness/index.ts` 导出以下内容。

### 类

- `AgentHarness`：有状态 Agent 运行时。
- `HarnessEventBus`：`HarnessEvent` 的订阅和发布实现。
- `Session`：单个会话的内存状态与持久化。
- `SessionManager`：列出或恢复一个项目中的 Session。
- `SessionError`：带 `SessionErrorCode` 的 Session 错误。

### 函数和常量

- `defaultSystemPrompt`、`formatSystemPrompt`：构建和格式化 system prompt。
- `liftAgentEvent`：给一个 `AgentEvent` 增加 Harness 运行身份。
- `MAIN_LANE`：当前唯一 lane 的值 `main`。

### 配置和 Session 类型

- `HarnessConfig`、`HarnessProject`
- `SystemPromptBuilder`、`SystemPromptContext`
- `SessionContext`、`SessionErrorCode`

### Event 类型

- `HarnessEvent`：唯一的完整事件联合类型。
- `HarnessEventContext`：公共的 `runId` 和 `lane`。
- `HarnessOwnedEvent`：Harness 自己产生的运行事件子集。
- `HarnessRunEndEvent`：`run_end` 的三种结果。
- `LiftAgentEvent`：增加运行身份后的 Agent Event 类型。
- `HarnessToolEvent`：工具执行事件子集，不是独立事件流。
- `HarnessListener`、`HarnessListenerErrorHandler`、`Unsubscribe`

## 当前没有实现的能力

当前 Harness 有意保持较小，只提供单 Session、单运行通道所需的核心能力。它还没有：

- 非 `main` 的 lane 或并行运行；
- Harness 自己的 Hook Call；
- retry、compaction、队列或公开的会话分支操作；
- snapshot/watch、skills 管理或 UI API。

这些能力以后应根据实际需求加入，不能从现有字段推断为已经支持。
