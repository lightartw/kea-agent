# Harness：用 Session 连续运行 Agent

一次 `StreamFn` 调用完成一次 LLM 请求；一次 `runAgentLoop()` 调用完成一次 Agent Run；
`AgentHarness` 驱动一个 Session，在同一份会话历史中执行多次 Run。

- Session 保存会话数据；
- AgentHarness 运行这个 Session；
- SessionRepository 创建、打开、列举、fork 和删除多个 Session。

Harness 没有 `subscribe()`，也没有私有的 EventBus。调用方在构造 Harness 时提供 `Events`
实例；同一个实例可以交给多份 Harness 共享。Session 和 Run 的身份（`sessionId`、`runId`）
让 listener 可以区分多个并发 Session。调用方也可以让多份 Session 复用一个 `Events`。

## 最小用法

下面的 Session 只存在于内存中。调用方订阅 `events` 后，`prompt()` 启动一次完整的 Run：

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
const session = Session.inMemory({ cwd: process.cwd() });
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

1. 创建 Run 的 `AbortController` 和身份 `run = { sessionId, runId }`；
2. 根据当前模型、工具、工作目录和日期生成 system prompt；
3. 通过 `events.emit("harness/run-start", run)` 发布 run 开始；
4. 调用一次 `runAgentLoop()`，把 `_messages` 本身作为只读视图交给 Agent，并实现
   `appendMessage`（先 `session.append({ type: "message", message })` 落盘，再更新内存视图）；
5. 在 `finally` 中清理 `activeRun` 和 busy 状态；如果已经发布 `run-start`，清理完成后再发布
   恰好一个 `harness/run-end`，其 `reason` 为 `completed`、`aborted` 或 `error`。

Agent 每次 `appendMessage` 都同步写入 Session；只有完整消息持久化成功后，Agent 才发布对应
的事实事件。如果 system prompt 生成失败，或者在生成期间收到 `abort()`，Run 还没有开始，
因此不会发布 `run-start` 或 `run-end`。

同一个 Harness 同时只运行一个 `prompt()`。忙碌时调用 `prompt()`、`switchModel()`、
`registerTool()` 或 `unregisterTool()` 会抛出 `AgentHarness is busy`；`abort()` 可以请求中止当前
Run，空闲时调用则不产生效果。中止信号优先于迟到的 listener 答案：只有真正的取消错误
（AbortSignal 的 reason 或 `AbortError`）被归类为 `aborted`；与取消同时发生的存储或系统错误仍
归类为 `error`，并由 `prompt()` 重新抛出。

## Session：一个独立的会话

一个 Session 是一份独立的会话历史：一条不可变、以 `parentId` 链接的节点链，加上指向当前
端点的 `headId`。`SessionMetadata` 承载会话身份、标题、cwd 和血缘；`SessionRepository` 是
唯一的公开持久化生命周期边界。Harness 选择并调用模型，Session 只持久化消息和分支范围内的
模型选择。

### 核心概念

- `SessionNode` 恰好有两种变体：`message` 和 `model_selection`；
- 节点不可变：`parentId` 把节点链接到父节点，`headId` 是当前端点；
- 没有公开的原地分支切换；分支的唯一入口是 `SessionRepository.fork(sourceSessionId, nodeId)`，
  它返回一个普通的新 Session；
- 删除源 Session 不影响已经 fork 出来的 Session；
- 助手消息的模型出处属于 `AgentMessage`（assistant 消息自带 `model` 字段），不属于 Session
  元数据。

### SessionNode 与 head

`session.nodes` 只包含 `message` 和 `model_selection` 节点（标题不是节点）。`session.headId`
是当前端点；`session.path(nodeId)` 沿 `parentId` 从根到该节点返回路径，`null` 返回空路径，
未知 ID 抛 `invalid_entry`。节点由 Session 生成 `id`、`parentId` 和 `createdAt`，追加后不可
修改。

### 消息与模型选择

- `session.messages()` 沿 head 的父链收集 `message` 节点中的消息，每次都返回新数组；
- `session.modelSelection()` 从最新到最旧扫描路径，返回第一个 `model_selection` 的选择，
  否则 `null`；
- `session.append({ type: "message", message })` 和
  `session.append({ type: "model_selection", selection })` 追加节点并立即持久化，返回生成的
  节点 ID。

Harness 只通过 `messages()` 和 `modelSelection()` 读取上下文；Session 不决定模型。

### fork：创建新的 Session

`SessionRepository.fork(sourceSessionId, nodeId)` 打开源 Session，复制根到 `nodeId` 的路径
（`nodeId` 为 `null` 时复制空路径），保留复制节点的 ID 和 `parentId`，生成新的 Session ID，
并把源 Session ID 记录为新 Session 的 `parentSessionId`。标题变更和兄弟节点不复制；fork 是
一个以会话历史为种子、元数据全新的 Session。

### SessionMetadata

`SessionMetadata` 包含会话身份和列举字段：`id`、`title`、`cwd`、`createdAt`、`updatedAt`，
fork 出的 Session 还有 `parentSessionId`。`title` 是 Session 级的，不是节点；`cwd` 是解析后
的绝对路径，重新打开编程 Session 时用它恢复工作目录。

### SessionRepository

创建、打开、列举、fork 和删除都通过 Repository：

```ts
const sessions = new SessionRepository(storageDir);
const session = await sessions.create({ cwd: process.cwd() });

await session.append({
  type: "message",
  message: { role: "user", content: "hello" },
});

const fork = await sessions.fork(session.metadata.id, session.headId);
```

- `create({ cwd })` 立即写入标题为 `"unknown"` 的 version-2 header，返回空 Session；
- `open(id)` 校验文件名/header 一致性，恢复节点、标题、cwd、模型选择和 head；
- `list()` 按存储的 `updatedAt` 从新到旧返回 `SessionMetadata[]`（相同时间按 ID 降序），
  空目录返回空数组；损坏或包含无效记录的 JSONL 会传播对应的 `SessionError`，不会静默忽略；
- `delete(id)` 幂等删除一个 Session 文件：文件不存在视为成功，不会检查或删除父/fork 文件。

`AgentHarness` 不持有 Repository。应用先用 Repository 取得 Session，再把该 Session 交给新的
Harness。`harness.sessionId` 标识 Harness 当前绑定的 Session，但不暴露可写的 Session 对象。

### JSONL 持久化

文件位于 `<storageDir>/sessions/<sessionId>.jsonl`。第一行是 version-2 header
（`type: "session"`、`version: 2`、`id`、`cwd`、`title`、`createdAt`，fork 时还有
`parentSessionId`）；后续行是节点（`message`、`model_selection`）和私有的 `session_title`
行。`session_title` 是追加式存储行，永远不会出现在 `session.nodes` 中；version-1 文件被显式
拒绝。

JSONL 复制是当前后端行为，不是公开语义。Session 通过内部的 `SessionStorage` 端口
（`session/storage.ts`，不对外导出）接收存储；Session 先等端口接受节点或标题，再发布内存
状态，因此端口换成未来共享的不可变节点存储时，公开 API 和逻辑语义保持不变。`SessionError.code`
说明失败类别：`not_found`、`invalid_session`、`invalid_entry` 或 `storage`。

### 与 AgentHarness 的边界

`AgentHarness` 构造时接收调用方提供的 Session。Harness 通过 `session.messages()` 和
`session.modelSelection()` 恢复上下文，通过 `session.append({ type: "message", ... })` 和
`session.append({ type: "model_selection", ... })` 写入，通过 `session.setTitle()` /
`setTitleIfUnknown()` 修改标题；`harness.sessionId` 和 `harness.title` 来自
`session.metadata`。

## Events：共享的运行事实通道

Harness 构造时接收调用方提供的 `events: Events`。Harness 发布两个 Run 边界事实，Agent 层
通过同一实例发布其余事实；如果调用方让多份 Harness 共享该实例，listener 需要按
`sessionId` 过滤：

```ts
// "harness/run-start": (input: AgentRunIdentity) => void | Promise<void>;
// "harness/run-end": (input: AgentRunIdentity & (
//   | { reason: "completed" | "aborted" }
//   | { reason: "error"; errorMessage: string }
// )) => void | Promise<void>;
```

每个事实事件都携带 `AgentRunIdentity`（`sessionId`、`runId`），共享实例上的 listener 用它过滤：

```ts
events.on("agent/turn-end", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  consume(input.message);
});
```

常见事实事件（均由 `src/core/agent/events.ts` 声明）：

- Run 边界：`harness/run-start`、`harness/run-end`；
- Turn：`agent/turn-start`、`agent/turn-end`；
- 流式内容：`agent/text-delta`、`agent/thinking-delta`；
- Tool call 生成：`agent/tool-call-start`、`agent/tool-call-delta`；
- Tool 完成：`agent/tool-call`、`agent/tool-result`。

### `EventMap` 与 `Events`

`EventMap` 是编译期契约：各包通过模块扩充把 event 名、输入和结果加入 `EventMap`，`Events.on()`
从选定事件自动推导 listener 类型。运行时 `Events` 提供三个方法：

- `on(name, listener)`：注册 listener，返回一个移除函数；
- `emit(name, input)`：按顺序调用全部 listener，逐个隔离异常并交给错误处理器；
- `intercept(name, input, handler, signal?)`：让 listener 包裹一个待执行行为，`handler` 是
  最终执行者。

`emit` 的 listener 错误被隔离，不会中断 Run；`intercept` 的 listener 错误原样穿透给行为拥有者。
注册顺序、错误和取消的通用规则见 [Events README](../events/README.md)。

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
和模型上下文开始生效。`setTitle()` 直接把标题追加到 Session，不受 Harness busy 状态限制。

## 包边界和源码位置

Harness 组合下层能力：`ai` 提供 `StreamFn` 与 `ModelConfig`；`agent` 提供
`runAgentLoop()`、消息、`AgentRunIdentity` 和 Tool Registry；`events` 提供共享 dispatcher。
具体 Tool 和项目级组装属于 Harness 上层。Harness 还通过仅供 core 内部使用的 `core/util`
复用通用错误处理。

- `index.ts`：包入口；
- `agent-harness.ts`：Session 的运行与控制；
- `types.ts`：`HarnessConfig` 与 system prompt 类型；
- `system-prompt.ts`：默认 builder 与模板格式化；
- `events.ts`：Run 边界事件契约；
- `session/session.ts`：单份 Session 的节点与投影逻辑（存储无关）；
- `session/storage.ts`：内部 `SessionStorage` 端口和 JSONL 后端（不对外导出）；
- `session/repository.ts`：多份 Session 的 `create/open/list/fork/delete` 生命周期；
- `session/types.ts`：`SessionMetadata`、`SessionNode`、错误类型。

## 完整公开导出

以下清单与 `src/core/harness/index.ts` 一致。

### 值

- `AgentHarness`：运行绑定的 Session；
- `Session`：保存和重建一份会话；
- `SessionRepository`：在一个存储目录中创建、打开、列举、fork 和删除 Session；
- `SessionError`：带有 `SessionErrorCode` 的会话错误；
- `defaultSystemPrompt`：把模板包装为 `SystemPromptBuilder`；
- `formatSystemPrompt`：替换模板的 `{{cwd}}` 和 `{{date}}`。

### 类型

- 配置与 system prompt：`HarnessConfig`、`SessionTitleGenerator`、
  `SystemPromptBuilder`、`SystemPromptContext`；
- Session：`SessionMetadata`、`SessionNode`、`SessionErrorCode`。

Harness 事件载荷使用 agent 包定义的 `AgentRunIdentity`，但 harness 入口不重新导出这个类型；
需要显式使用时从 `core/agent` 入口导入。
