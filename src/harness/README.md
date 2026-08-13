# Harness：用 Session 连续运行 Agent

一次 `StreamFn` 调用完成一次 LLM 请求；一次 `runAgentLoop()` 调用完成一次 Agent Run；
`AgentHarness` 驱动一个 Session，在同一份会话历史中执行多次 Run。

- Session 保存会话数据；
- AgentHarness 运行这个 Session；
- SessionRepository 创建、打开和列举多个 Session。

Harness 没有 `subscribe()`，也没有私有的 EventBus。运行事实通过 **Project 提供的共享
`Events`** 实例发布；Session 和 Run 的身份（`sessionId`、`runId`、`lane`）让 UI 可以从多个
并发 Session 中选择自己要渲染的那一个。

## 最小用法

下面的 Session 只存在于内存中。UI 订阅 `events` 后，`prompt()` 启动一次完整的 Run：

```ts
import { createStreamFn } from "../ai/index.js";
import { AgentToolRegistry } from "../agent/index.js";
import { Events } from "../events/index.js";
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
const events = new Events();
const harness = new AgentHarness({
  session,
  model: defaultModel,
  streamFn: stream,
  toolRegistry: new AgentToolRegistry(),
  systemPrompt: defaultSystemPrompt("You are a helpful assistant."),
  cwd: process.cwd(),
  events,
});

const unsubscribe = events.on("agent/text-delta", (input) => {
  if (input.sessionId === harness.sessionId) process.stdout.write(input.text);
});

await harness.prompt("Explain what a session is.");
unsubscribe();
```

## `prompt()`：一次完整的 Run

一次 `prompt()` 不等于一次 LLM 请求。模型可以先请求工具，再根据工具结果继续请求模型，因此
一个 Run 可能包含多次 `StreamFn` 调用和多次 Tool 调用。`prompt()` 等到整个 Run 完成、中止或
失败后才结束。

运行时，Harness 依次完成这些工作：

1. 创建 Run 的 `AbortController` 和身份 `run = { sessionId, runId, lane }`；
2. 根据当前模型、工具、工作目录和日期生成 system prompt；
3. 通过 `events.emit("harness/run-start", run)` 发布 run 开始；
4. 调用一次 `runAgentLoop()`，把 `_messages` 本身作为只读视图交给 Agent，并实现
   `appendMessage`（先 `session.appendMessage` 落盘，再更新内存视图）；
5. 在 `finally` 中清理 `activeRun` 并发布恰好一个 `harness/run-end`，其 `reason` 为
   `completed`、`aborted` 或 `error`。

Agent 每次 `appendMessage` 都同步写入 Session；只有完整消息持久化成功后，Agent 才发布对应
的事实事件。如果 system prompt 尚未生成就失败，Run 还没有开始，因此不会发布 `run_start`
或 `run_end`。

同一个 Harness 同时只运行一个 `prompt()`。忙碌时调用 `prompt()`、`switchModel()`、
`registerTool()` 或 `unregisterTool()` 会抛出 `AgentHarness is busy`；`abort()` 可以请求中止当前
Run，空闲时调用则不产生效果。中止信号优先于迟到的 listener 答案：Run 按 `aborted` 分类，
取消类错误不会重新抛出。

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

## Events：共享的运行事实通道

Harness 构造时接收 `events: Events`——它是 Project 拥有的唯一实例，一份 Project 的所有
Session 共享。Harness 发布两个 Run 边界事件，Agent 层发布其余事实：

```ts
export const MAIN_LANE = "main";

export type HarnessRunEndInput = AgentRunIdentity & (
  | { reason: "completed" | "aborted" }
  | { reason: "error"; errorMessage: string }
);

// "harness/run-start": EventContract<"emit", AgentRunIdentity>;
// "harness/run-end":   EventContract<"emit", HarnessRunEndInput>;
```

没有 `HarnessEvent` 联合类型，也没有 `liftAgentEvent`。每个事实事件都携带
`AgentRunIdentity`（`sessionId`、`runId`、`lane`），UI 用它过滤：

```ts
events.on("agent/turn-end", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  render(input.message);
});
```

常见事实事件（均由 `src/agent/events.ts` 声明）：

- Run 边界：`harness/run-start`、`harness/run-end`；
- Turn：`agent/turn-start`、`agent/turn-end`；
- 流式内容：`agent/text-delta`、`agent/thinking-delta`；
- Tool call 生成：`agent/toolcall-start`、`agent/toolcall-delta`、`agent/toolcall-end`；
- Tool 执行：`agent/tool-start`、`agent/tool-end`、`agent/tool-rejected`。

### `EventMap` 与 `Events`

`EventMap` 是编译期契约：各包通过模块扩充把 `EventContract` 加入 `EventMap`，`Events.on()`
从选定事件自动推导 listener 签名。运行时 `Events` 提供四种方法：

- `on(name, listener)`：注册 listener，返回幂等的 `Unregister`；
- `emit(name, input)`：按顺序调用全部 listener，逐个隔离异常并交给 `onListenerError`；
- `ask(name, input, signal?)`：返回第一个非 `undefined` 答案，不调用后续 listener；
- `transform(name, input, signal?)`：把每个返回值传给下一个 listener；listener 不调用
  `next()` 时终止链。

`emit` 的 listener 错误被隔离，不会中断 Run；`ask`/`transform` 的 listener 错误原样穿透。
控制（`ask`/`transform`）在状态提交前执行，事实（`emit`）报告已经发生的事实——两者是不同通道。

## 配置 `AgentHarness`

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
  readonly events: Events;
  readonly titleGenerator?: SessionTitleGenerator;
}
```

- `session` 提供历史并接收新增消息和模型变更；Session 已保存的模型优先于 `model`；
- `model` 是 Session 没有保存模型时的初始 `ModelConfig`；
- `streamFn` 完成一次对指定 provider/model 的流式 LLM 请求；
- `toolRegistry` 提供本次 Agent 可以看见和执行的 Tool；
- `events` 是共享的 `Events` 实例，Harness 发布 `harness/*` 并把同一实例传给 Agent；
- `systemPrompt` 是每个 Run 开始前调用的 builder；
- `cwd` 进入 `SystemPromptContext`，让 builder 描述当前工作目录；
- `titleGenerator` 是可选的自动标题生成器（见下）。

`SystemPromptBuilder` 接收当前 `model`、注册的 `tools`、`cwd` 和 `date`，返回字符串或
`Promise<string>`。`defaultSystemPrompt(template)` 将模板包装成 builder；
`formatSystemPrompt(content, options)` 替换 `{{cwd}}` 和 `{{date}}`。

### 自动标题

当 `titleGenerator` 存在、Session 标题仍为 `"unknown"` 且恢复历史中还没有 user 消息时，
Harness 在第一个真实 user 消息持久化后启动一次后台标题请求。它只使用该消息与当前模型，
无 Tools，返回单行 ≤100 字符标题，经 `setTitleIfUnknown()` 写入；失败、超长或晚到的结果都
不会覆盖已修改的标题，也不会阻塞或失败 Agent Run。标题请求不产生任何事件。

### `AgentHarness` 的公开成员

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
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
`runAgentLoop()`、消息、`AgentRunIdentity` 和 Tool Registry；`events` 提供共享 dispatcher。
具体 coding tools、交互 UI 和项目级组装属于 Harness 上层。

- `index.ts`：包入口；
- `agent-harness.ts`：Session 的运行与控制；
- `types.ts`：`HarnessConfig` 与 system prompt 类型；
- `system-prompt.ts`：默认 builder 与模板格式化；
- `events.ts`：Run 边界事件契约（`MAIN_LANE`、`HarnessRunEndInput`）；
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
- `defaultSystemPrompt`：把模板包装为 `SystemPromptBuilder`；
- `formatSystemPrompt`：替换模板的 `{{cwd}}` 和 `{{date}}`；
- `MAIN_LANE`：当前 lane 值 `main`。

### 类型

- 配置与 system prompt：`HarnessConfig`、`SessionTitleGenerator`、
  `SystemPromptBuilder`、`SystemPromptContext`；
- Session：`CreateSessionInput`、`SessionHeader`、`SessionInfo`、`SessionContext`、
  `SessionErrorCode`；
- 事件：`HarnessRunEndInput`；
- `AgentRunIdentity` 来自 `agent` 包，是所有事件共用的身份类型。
