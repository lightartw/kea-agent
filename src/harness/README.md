# Harness：用 Session 连续运行 Agent

一次 `StreamFn` 调用完成一次 LLM 请求；一次 `runAgentLoop()` 调用完成一次 Agent Run；
`AgentHarness` 驱动一个 Session，在同一份会话历史中执行多次 Run。

- Session 保存会话数据；
- AgentHarness 运行这个 Session；
- SessionRepository 创建、打开和列举多个 Session。

## 最小用法

下面的 Session 只存在于内存中。订阅者接收运行事件，`prompt()` 则启动一次完整的 Run：

```ts
import { createStreamFn } from "../ai/index.js";
import { AgentToolRegistry } from "../agent/index.js";
import {
  AgentHarness,
  Session,
  defaultSystemPrompt,
} from "./index.js";

const { stream, defaultModel } = createStreamFn();
const session = Session.inMemory({
  projectId: "test",
  directory: process.cwd(),
  cwd: ".",
});
const harness = new AgentHarness({
  session,
  model: defaultModel,
  streamFn: stream,
  toolRegistry: new AgentToolRegistry(),
  systemPrompt: defaultSystemPrompt("You are a helpful assistant."),
  cwd: process.cwd(),
});

const unsubscribe = harness.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});

await harness.prompt("Explain what a session is.");
unsubscribe();
```

## `prompt()`：一次完整的 Run

一次 `prompt()` 不等于一次 LLM 请求。模型可以先请求工具，再根据工具结果继续请求模型，因此
一个 Run 可能包含多次 `StreamFn` 调用和多次 Tool 调用。`prompt()` 等到整个 Run 完成、中止或
失败后才结束。

运行时，Harness 依次完成这些工作：

1. 根据当前模型、工具、工作目录和日期生成 system prompt；
2. 发布带有新 `runId` 的 `run_start`；
3. 调用 `runAgentLoop()`，持久化它新增的消息，并发布提升后的 Agent Event；
4. 发布 `run_end`，其 `reason` 为 `completed`、`aborted` 或 `error`。

Harness 把新消息写回构造时绑定的 Session。下一次调用 `prompt()` 时，Agent 继续使用同一份历史。
如果 system prompt 尚未生成就失败，Run 还没有开始，因此不会发布 `run_start` 或 `run_end`。

同一个 Harness 同时只运行一个 `prompt()`。忙碌时调用 `prompt()`、`switchModel()`、
`registerTool()` 或 `unregisterTool()` 会抛出 `AgentHarness is busy`；`abort()` 可以请求中止当前
Run，空闲时调用则不产生效果。

## Session：一份会话的数据

Session 拥有版本化 JSONL 头、消息、模型变更、标题和会话 ID。文件第一行是 `session` header
（`type`、`version: 1`、`id`、`projectId`、`directory`、`cwd`、`title`、`createdAt`）；后续行是
记录：`message`、`model_change` 或 `session_title`。

- `message` 和 `model_change` 组成一棵会话树；当前 Agent 沿当前叶节点线性追加。
  `buildContext()` 从根到当前叶重新构造可运行的上下文。
- `session_title` 是 Session 级记录，不影响会话树；`Session.info.title` 返回最新标题。
- 新 Session 创建后**立即持久化** header，标题为 `"unknown"`；任何新增记录都会同步写入文件。

### 创建、恢复与内存模式

```ts
const temporary = Session.inMemory({
  projectId: "p",
  directory: process.cwd(),
  cwd: ".",
});
const persistent = await Session.create(".kea", {
  projectId: "p",
  directory: process.cwd(),
  cwd: ".",
});
```

- `Session.inMemory(input)` 创建不写入文件的 Session，适合测试和临时运行；
- `Session.create(storageDir, input)` 创建持久化 Session 并立即写入 header；
- `Session.open(storageDir, sessionId)` 从 JSONL 文件恢复 Session，并拒绝无 header 的旧文件；
- `appendMessage(message)` 追加消息；
- `appendModelChange(model)` 追加模型变更；
- `setTitle(title)` / `setTitleIfUnknown(title)` 修改标题；
- `info` 返回不可变的 `SessionInfo`（含 `title`、`createdAt`、`updatedAt`）；
- `buildContext()` 返回 `SessionContext`。

持久化 Session 的文件位于 `<storageDir>/sessions/<sessionId>.jsonl`。`updatedAt` 等于最后成功
追加记录的 `createdAt`。`SessionError.code` 说明失败类别：`not_found`、
`invalid_session`、`invalid_entry` 或 `storage`。

## SessionRepository：管理多份 Session

应用需要在一个存储目录中创建、打开或列举多份 Session 时，使用 `SessionRepository`：

```ts
const repository = new SessionRepository(storageDir);
const sessions = await repository.list();
const recent = sessions[0] === undefined
  ? await repository.create(input)
  : await repository.open(sessions[0].id);
```

`create(input)` 和 `open(id)` 返回 Session；`list()` 通过 `Session.open()` 读取每个候选文件，
按存储的 `updatedAt` 从新到旧排列并返回 `SessionInfo[]`（相同时间按 ID 降序）。空目录返回空
数组；损坏的 JSONL 会让 `list()` 以 `invalid_session` 拒绝，而不会静默忽略。

`AgentHarness` 不持有 Repository。应用先用 Repository 取得 Session，再把该 Session 交给新的
Harness。`harness.sessionId` 标识 Harness 当前绑定的 Session，但不暴露可写的 Session 对象。

## Event Bus：报告运行事实

`AgentHarness.subscribe(listener)` 把 listener 注册到内部 `HarnessEventBus`，并返回幂等的
`unsubscribe()`。每个 `HarnessEvent` 都带有：

- `runId`：一次 `prompt()` 的唯一 ID；
- `lane`：运行通道；当前值为常量 `MAIN_LANE`，即 `main`；
- `type`：发生的事实，例如 `run_start`、`text_delta`、`tool_end` 或 `run_end`。

Harness 自己发布 `run_start` 和 `run_end`。`runAgentLoop()` 产生的 `AgentEvent` 由
`liftAgentEvent()` 加上 `runId` 和 `lane` 后发布。常见事件包括：

- Run：`run_start`、`run_end`；
- Agent 与 LLM 请求：`agent_start`、`agent_end`、`turn_start`、`turn_end`；
- 流式内容：`text_delta`、`thinking_delta`；
- Tool call 生成：`toolcall_start`、`toolcall_delta`、`toolcall_end`；
- Tool 执行：`tool_start`、`tool_end`、`tool_rejected`。

Listener 按订阅顺序执行，异步结果也会被等待。某个 listener 抛错不会中断 Run 或阻止其他
listener；Harness 把错误交给 `onEventListenerError`。一次发布使用当时的 listener 快照，
订阅变化从下一个 Event 开始生效。

直接使用 Event Bus 时，它的公开接口是：

```ts
class HarnessEventBus {
  constructor(onListenerError?: HarnessListenerErrorHandler);
  subscribe(listener: HarnessListener): Unsubscribe;
  publish(event: HarnessEvent): Promise<void>;
}
```

Event 和 Hook 作用于不同阶段。Event 通过 `subscribe()` 报告已经发生的事实，listener 的
返回值会被忽略。Hook 通过 `AgentHookTrigger.trigger()` 在提交前执行，可以按具体 Hook 契约
阻止或转换 user prompt、上下文、Tool call、Tool result 或停止行为。Harness 从
`HarnessConfig.hooks` 接收这个窄触发接口；它不定义另一套 Hook 类型。

## 配置 `AgentHarness`

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
  readonly titleGenerator?: SessionTitleGenerator;
}
```

- `session` 提供历史并接收新增消息和模型变更；Session 已保存的模型优先于 `model`；
- `model` 是 Session 没有保存模型时的初始 `ModelConfig`；
- `streamFn` 完成一次对指定 provider/model 的流式 LLM 请求；
- `toolRegistry` 提供本次 Agent 可以看见和执行的 Tool；
- `hooks` 是可选的 Hook Trigger，省略时 Harness 使用空 Registry；
- `systemPrompt` 是每个 Run 开始前调用的 builder；
- `cwd` 进入 `SystemPromptContext`，让 builder 描述当前工作目录；
- `onEventListenerError` 接收被 Event Bus 隔离的 listener 错误；
- `titleGenerator` 是可选的自动标题生成器（见下）。

`SystemPromptBuilder` 接收当前 `model`、注册的 `tools`、`cwd` 和 `date`，返回字符串或
`Promise<string>`。`defaultSystemPrompt(template)` 将模板包装成 builder；
`formatSystemPrompt(content, options)` 替换 `{{cwd}}` 和 `{{date}}`。

### 自动标题

当 `titleGenerator` 存在、Session 标题仍为 `"unknown"` 且恢复历史中还没有 user 消息时，
Harness 在第一个真实 user 消息持久化后启动一次后台标题请求。它只使用该消息与当前模型，
无 Tools，返回单行 ≤100 字符标题，经 `setTitleIfUnknown()` 写入；失败、超长或晚到的结果都
不会覆盖已修改的标题，也不会阻塞或失败 Agent Run。标题请求不产生 Harness Event。

### `AgentHarness` 的公开成员

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  subscribe(listener: HarnessListener): Unsubscribe;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  setTitle(title: string): Promise<void>;
  get sessionId(): string;
  get title(): string;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}
```

`messages` 是当前上下文的只读视图，`model` 是当前模型，`isRunning` 表示一个 Run 是否正在
执行。`switchModel()` 会把选择持久化到 Session；工具注册变更从下一次 Run 的 system prompt
和模型上下文开始生效。

## 包边界和源码位置

Harness 组合下层能力：`ai` 提供 `StreamFn` 与 `ModelConfig`；`agent` 提供
`runAgentLoop()`、消息、Event、Tool Registry 和 Hook Trigger。具体 coding tools、交互 UI 和
项目级组装属于 Harness 上层。

- `index.ts`：包入口；
- `agent-harness.ts`：Session 的运行与控制；
- `types.ts`：`HarnessConfig` 与 system prompt 类型；
- `system-prompt.ts`：默认 builder 与模板格式化；
- `events/event-bus.ts`：订阅和发布；
- `events/types.ts`：Harness Event 类型与提升函数；
- `session/session.ts`：单份 Session 的数据和持久化；
- `session/repository.ts`：多份 Session 的 `create/open/list`；
- `session/types.ts`：`SessionContext`、错误和存储记录类型。

## 完整公开导出

以下清单与 `src/harness/index.ts` 一致。

### 值

- `AgentHarness`：运行绑定的 Session；
- `Session`：保存和重建一份会话；
- `SessionRepository`：在一个存储目录中创建、打开和列举 Session；
- `SessionError`：带有 `SessionErrorCode` 的会话错误；
- `HarnessEventBus`：订阅并顺序发布 `HarnessEvent`；
- `defaultSystemPrompt`：把模板包装为 `SystemPromptBuilder`；
- `formatSystemPrompt`：替换模板的 `{{cwd}}` 和 `{{date}}`；
- `MAIN_LANE`：当前 lane 值 `main`；
- `liftAgentEvent`：给 `AgentEvent` 加上 `HarnessEventContext`。

### 类型

- 配置与 system prompt：`HarnessConfig`、`SessionTitleGenerator`、
  `SystemPromptBuilder`、`SystemPromptContext`；
- Session：`CreateSessionInput`、`SessionHeader`、`SessionInfo`、`SessionContext`、
  `SessionErrorCode`；
- Event：`HarnessEvent`、`HarnessEventContext`、`HarnessOwnedEvent`、
  `HarnessRunEndEvent`、`HarnessToolEvent`、`LiftAgentEvent`；
- 订阅：`HarnessListener`、`HarnessListenerErrorHandler`、`Unsubscribe`
