# Harness

`ai` 提供一次 LLM 请求所需的 `ModelRuntime`，`agent` 提供一次完整运行所需的
`runAgentLoop()`，`events` 提供共享事件通道。Harness 把它们和一个 Session 组合起来：
`AgentHarness` 在同一份会话历史中反复运行 Agent，并把每次运行的边界发布到调用方提供的
`Events`。

本章只解释 Harness 新增的职责。`ModelRuntime`、`runAgentLoop()`、Tool Registry、`Events` 和
`EventMap` 的基础规则不再重复，请先阅读各自模块的 README。

## 最小用法

下面的 Session 只存在于内存中。调用方订阅 `events` 后，`prompt()` 启动一次完整的 Run：

```ts
import { createModelRuntime } from "../ai/index.js";
import { AgentToolRegistry } from "../agent/index.js";
import { Events } from "../events/index.js";
import { AgentHarness, Session } from "./index.js";

const { runtime, modelConfig } = createModelRuntime();
const session = Session.inMemory({ cwd: process.cwd() });
const events = new Events();
const harness = new AgentHarness({
  session,
  runtime,
  modelConfig,
  toolRegistry: new AgentToolRegistry(),
  systemPrompt: "You are a helpful assistant.",
  events,
});

const unsubscribe = events.on("agent/text-delta", (input) => {
  if (input.sessionId === harness.sessionId) process.stdout.write(input.text);
});

await harness.prompt("Explain what a session is.");
unsubscribe();
```

## Harness Events

[`events.ts`](./events.ts) 没有运行时代码。它只扩充公共 `EventMap`，声明 Harness 自己拥有的
两个 Run 边界事件：

```ts
// "harness/run-start": (input: AgentRunIdentity) => void | Promise<void>;
// "harness/run-end": (input: HarnessRunEnd) => void | Promise<void>;
```

`harness/run-start` 表示 Harness 已经创建本次 Run 的身份和中止控制，即将进入 Agent；
`harness/run-end` 表示 Agent 已经结束，而且 Harness 已经清除了本次 Run 的运行状态。只要发布过
一次 `run-start`，就会在随后发布恰好一次 `run-end`。结束原因分别表示正常完成、主动中止和
运行失败；失败事件额外携带 `errorMessage`。

Agent 内部的 Turn、流式内容和 Tool 事件仍由 Agent 模块声明，Harness 不重复声明。

`AgentHarness` 使用调用方传入的 `Events`，并把同一个实例交给 Agent。多份 Harness 可以共享
一个实例；此时 listener 用 `AgentRunIdentity` 中的 `sessionId` 过滤目标 Session：

```ts
events.on("agent/turn-end", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  consume(input.message);
});
```

事件注册、错误隔离和取消规则完全沿用 [Events README](../events/README.md)。

## AgentHarness

`AgentHarness` 是一个有状态的单 Session 运行器。它持有 Session、当前模型、Tool Registry 和
正在运行的 Run；它不创建或查找 Session，这些工作属于后文的 `SessionRepository`。

### 构造与恢复

构造函数接收以下依赖：

```ts
interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: Events;
}
```

- `session` 提供历史并接收新增消息和模型变更；Session 已保存的模型优先于 `modelConfig`；
- `runtime` 提供 provider 路由和对指定 provider/model 的 LLM 请求；它不保存当前模型；
- `modelConfig` 是 Session 没有保存模型时的初始 `ModelConfig`；
- `toolRegistry` 提供本次 Agent 可以看见和执行的 Tool；
- `systemPrompt` 是直接交给 Agent 的最终字符串；
- `events` 是共享的 `Events` 实例，Harness 发布 `harness/*` 并把同一实例传给 Agent。

构造时，如果 Session 中保存过模型选择，Harness 从 Session 恢复模型，否则使用配置中的
`modelConfig`。消息仍由 Session 持有，Harness 在每次 `prompt()` 开始时取得当前路径的消息。
构造后 `currentModel` 是运行时的权威模型；`model_selection` 是 Session 的持久记录，用于恢复
这项权威状态，`ModelRuntime` 永远不拥有它。

### `prompt()`：一次完整的 Run

一次 `prompt()` 对应一次 `runAgentLoop()`，不等于一次 `runtime.stream()` 调用。模型可能先请求 Tool，
再根据 Tool Result 继续请求模型，因此一次 Run 内可以发生多次 LLM 请求。

`prompt(input)` 的执行顺序如下：

1. 创建本次 Run 的 `AbortController` 和 `{ sessionId, runId }`；
2. 发布 `harness/run-start`；
3. 调用一次 `runAgentLoop()`，传入已有消息、system prompt、Tools、Events 和 Run 身份；
4. Agent 产生完整消息时，`appendMessage` 先调用 `session.append()` 持久化，成功后才把消息加入
   本次 Run 的消息数组；
5. Agent 完成、中止或失败后，Harness 先清理运行状态，再发布一个对应的 `harness/run-end`；
6. 如果是运行失败，在发布 `run-end` 后把原错误重新抛给调用方。

这里最重要的边界是：`AgentHarness` 负责一次 Run 的身份、状态和收尾，Run 内部如何多轮请求模型、
执行 Tool，仍由 `runAgentLoop()` 负责。

### 运行状态与中止

同一个 `AgentHarness` 同时只允许一个 `prompt()`。运行期间再次调用 `prompt()`、
`switchModel()`、`registerTool()` 或 `unregisterTool()`，会抛出 `AgentHarness is busy`，避免正在
运行的 Agent 看到中途变化的模型或 Tools。

`abort()` 在空闲时没有效果；运行时，它请求中止当前 Run。只有 AbortSignal 的 `reason` 或
`AbortError` 被当作正常中止。即使已经请求中止，同时发生的存储错误或其他系统错误仍属于
`error`，不会被取消信号掩盖。发布 `harness/run-end` 时，`isRunning` 已经恢复为 `false`。

### 模型、Tools 与标题

`switchModel()` 先把模型选择写入 Session，成功后才更新 Harness 的当前模型。`registerTool()`
和 `unregisterTool()` 修改传入的 Tool Registry；新的 Tools 从下一次 Run 开始进入 Agent 上下文。
`setTitle()` 直接写入 Session，不受 busy 状态限制。

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

`messages` 返回 Session 当前路径的消息快照，`model` 是当前模型，`isRunning` 表示一个 Run 是否正在
执行。`switchModel()` 会把选择持久化到 Session；工具注册变更从下一次 Run 的模型上下文开始
生效。`setTitle()` 直接把标题追加到 Session，不受 Harness busy 状态限制。

## System Prompt

`AgentHarness` 调用 `runAgentLoop()` 时必须构造 `AgentContext`，而 `AgentContext` 包含
system prompt，因此 `HarnessConfig` 需要接收这个值。它是 Run 的配置，不是会话历史，不写入
Session。

Harness 接收的是最终字符串，不生成、不格式化也不修改它；同一份 Harness 的每次 Run 都使用
这个字符串。切换模型或增删 Tools 不会重建 system prompt。

Harness 也不需要单独接收 `cwd`。Coding Agent 创建 Harness 时读取
`session.metadata.cwd`，把 system prompt 模板中的 `{{cwd}}` 和 `{{date}}` 替换成当时的值，
再传入最终字符串。这样 Session 是 cwd 的唯一来源，模板规则留在 Coding Agent，Harness 只负责
传递结果。若以后出现明确的动态生成需求，再增量扩展这个边界。

# Session

Session 模块负责保存和恢复会话。它把一份会话表示为逻辑节点、当前节点和元数据；调用方通过
`SessionRepository` 管理多份 Session，底层持久化由内部的 `SessionStorage` 完成。

## 核心概念

- `SessionNode` 是会话历史中的一个逻辑节点；
- `SessionMetadata` 是会话当前的身份和描述信息；
- `Session` 保存一份会话的节点、当前端点和元数据，并提供读取与修改行为；
- `SessionRepository` 创建、打开、列举、fork 和删除多份 Session；
- `SessionStorage` 是 Repository 内部使用的持久化接口，不从 Harness 包入口导出。

调用方主要使用 `Session` 和 `SessionRepository`。`SessionStorage`、`SessionRecord` 和 JSONL
格式只在理解持久化实现时才需要关注。

## Session

一个 `Session` 表示一份独立的逻辑会话。它保存以 `parentId` 连接的节点树，并用 `headId`
选择当前路径的端点。Harness 负责运行模型；Session 只负责会话状态，不选择或调用模型。

### SessionNode、head 与路径

`SessionNode` 有两种变体：

- `message` 保存一条 `AgentMessage`；
- `model_selection` 保存从该节点开始生效的模型选择。

每个节点都包含 Session 生成的 `id`、`parentId` 和 `createdAt`。根节点的 `parentId` 为 `null`；
其他节点指向自己的父节点。节点加入 Session 后不再修改。

`session.headId` 是当前端点。`session.path()` 从 head 沿 `parentId` 回到根，再返回根到 head
的有序路径；传入指定节点 ID 时返回根到该节点的路径；传入 `null` 返回空路径；未知 ID 抛出
`not_found`。

`session.nodes` 返回 Session 中的全部逻辑节点。当前实现用 `nodeById` 作为节点的唯一内存容器：
Map 的键用于按 ID 查找，值的插入顺序用于返回 `nodes`。

### SessionMetadata

`SessionMetadata` 保存 `id`、`title`、`cwd`、`createdAt` 和 `updatedAt`；fork 得到的 Session
还包含 `parentSessionId`。`title` 是 Session 级状态，不是节点。`cwd` 是解析后的绝对路径，
用于恢复这份会话对应的工作目录。

助手消息使用了哪个模型记录在 assistant `AgentMessage` 自身的 `model` 字段中；
`model_selection` 节点表示后续 Run 应选择哪个模型，两者不属于 SessionMetadata。

### 读取当前上下文

- `messages(nodeId?)` 读取指定路径上的 `message` 节点并返回消息；默认读取当前 head 路径；
- `modelSelection(nodeId?)` 从指定路径的末端向根扫描，返回最近的 `model_selection`，没有则
  返回 `null`；
- `nodes`、`path()` 和 `messages()` 每次返回新的数组。

Harness 通过 `messages()` 恢复模型上下文，通过 `modelSelection()` 恢复当前模型选择。

### 修改 Session

`append()` 接收调用方提供的节点内容，Session 自己补齐节点身份和父子关系：

```ts
const nodeId = await session.append({
  type: "message",
  message: { role: "user", content: "hello" },
});
```

追加模型选择使用同一个方法：

```ts
await session.append({
  type: "model_selection",
  selection: { provider: "openai", model: "gpt-5" },
});
```

`setTitle()` 修改当前标题。所有修改都先等待 Storage 接受，再更新 Session 内存；持久化失败
不会发布新的节点、head 或标题。

### 内部状态与修改顺序

Session 的私有状态各自只有一个职责：

- `nodeById` 是节点的唯一内存容器，同时支持按 ID 查找和按插入顺序遍历；
- `_headId` 指向当前路径端点；
- `metadataState` 保存当前元数据；
- `storage` 指向 Repository 共享的 Storage；内存 Session 没有 Storage。

### 与 AgentHarness 的边界

`AgentHarness` 构造时接收调用方提供的 Session。它读取 `messages()` 和
`modelSelection()`，通过 `append()` 写入消息和模型选择，通过 `setTitle()` 修改标题。
`harness.sessionId` 和 `harness.title` 来自 `session.metadata`；Harness 不暴露可写的 Session
对象。

## SessionRepository

一个 Project 对应一个 `SessionRepository`。Repository 拥有一个 `SessionStorage`，并负责把
Storage 返回的 `{ metadata, nodes }` 构造成可用的 Session。它不直接读写文件，也不解析
JSONL。

### 创建、打开、列举和删除

```ts
const sessions = new SessionRepository(storageDir);
const session = await sessions.create({ cwd: process.cwd() });
const reopened = await sessions.open(session.id);
const metadata = await sessions.list();
await sessions.delete(session.id);
```

- `create({ cwd })` 生成 metadata 和空节点列表，等待 Storage 创建持久化数据，再返回 Session；
- `open(id)` 从 Storage 取得 metadata 和 nodes，再恢复 Session；
- `list()` 按存储的 `updatedAt` 从新到旧返回 `SessionMetadata[]`（相同时间按 ID 降序），
  空目录返回空数组；
- `delete(id)` 幂等删除一份 Session；目标不存在也视为成功。

Repository 持久创建成功后才构造 Session，因此不会返回一份尚未创建对应存储的对象。

### fork

`fork(sourceSessionId, nodeId)` 打开源 Session，取得根到 `nodeId` 的路径，用这组节点创建一份
新的 Session。新 Session 使用新的 ID 和时间，并在 metadata 中记录 `parentSessionId`：

```ts
const fork = await sessions.fork(session.id, session.headId);
```

节点保留原来的 ID 和 `parentId`，但源 Session 的标题记录和路径外的兄弟节点不会复制。
`nodeId` 为 `null` 时创建空 Session。删除源 Session 不影响已经创建的 fork。

### 内部边界

Repository 只编排生命周期：

- `create()` 和 `fork()` 先调用 `storage.create()`，再调用 `Session.fromStorage()`；
- `open()` 把 `storage.load()` 的结果交给 `Session.fromStorage()`；
- `list()` 和 `delete()` 直接委托给 Storage。

`AgentHarness` 不持有 Repository。应用先用 Repository 取得 Session，再把 Session 交给
Harness。

## SessionStorage

`SessionStorage` 是内部持久化接口。一个 Repository 持有一个 Storage，该 Storage 管理多份
Session。接口只有 `create/load/list/append/delete`，其中 `create/load` 在边界上交换逻辑的
`metadata` 和 `nodes`。

### SessionRecord

`SessionRecord` 是 Storage 接受和解析的一条持久化记录：

- `message` 和 `model_selection` 记录同时也是 `SessionNode`；
- `session_title` 表示标题变化，只用于持久化，不是节点。

Session 的内存状态不保存 `SessionRecord[]`。Storage 加载数据时把标题记录折叠进当前 metadata，
只把逻辑 nodes 返回给 Session。Session 修改标题时会把一次标题变化交给 Storage；Storage 接受后，
Session 只更新 `metadataState`。

### 创建、加载与追加

创建一份持久化 Session：

1. Repository 构造 `{ metadata, nodes: [] }`；
2. Storage 校验并持久化 metadata 和 nodes；
3. Repository 用同一份逻辑数据构造 Session。

重新打开一份 Session：

1. Storage 读取并解析全部持久化记录；
2. Storage 校验节点关系，把最后的标题和最新时间折叠进 metadata；
3. Storage 返回 `{ metadata, nodes }`；
4. Repository 用它构造 Session。

追加节点或标题：

1. Session 构造并校验一条完整记录；
2. `Storage.append()` 持久接受该记录；
3. Session 更新对应的节点、head 或 metadata。

### JsonlSessionStorage

文件位于 `<storageDir>/sessions/<sessionId>.jsonl`。第一行是 version-2 header
（`type: "session"`、`version: 2`、`id`、`cwd`、`title`、`createdAt`，fork 时还有
`parentSessionId`）；后续每行是一条 `SessionRecord`。version-1 文件被显式拒绝。

`create()` 先写入临时文件，再通过 rename 发布最终文件；`load()` 校验 header、文件名、记录和
节点树；`list()` 忽略隐藏文件、临时文件和非 JSONL 文件，但不会静默忽略损坏的 Session；
`delete()` 只删除指定 Session 文件。

解析或树结构错误分别使用 `invalid_session`、`invalid_record`；文件系统失败使用 `storage`；
目标不存在使用 `not_found`。

# 包边界和公开导出

## 包边界和源码位置

Harness 组合下层能力：`ai` 提供 `ModelRuntime` 与 `ModelConfig`；`agent` 提供
`runAgentLoop()`、消息、`AgentRunIdentity` 和 Tool Registry；`events` 提供共享 dispatcher。
具体 Tool 和项目级组装属于 Harness 上层。Harness 还通过仅供 core 内部使用的 `core/util`
复用通用错误处理。

- `index.ts`：包入口；
- `agent-harness.ts`：Session 的运行与控制；
- `types.ts`：`HarnessConfig`；
- `events.ts`：Run 边界事件契约；
- `session/types.ts`：公开契约，以及内部的 `SessionRecord`/`SessionStorage` 契约；
- `session/records.ts`：纯解析、脱离、ID 生成与树校验；
- `session/session.ts`：单份 Session 的内存状态与行为；
- `session/storage.ts`：一个 Repository 内所有 Session 的 JSONL 持久化；
- `session/repository.ts`：公开的生命周期编排。

## 完整公开导出

以下清单与 `src/core/harness/index.ts` 一致。

### 值

- `AgentHarness`：运行绑定的 Session；
- `Session`：保存和重建一份会话；
- `SessionRepository`：在一个存储目录中创建、打开、列举、fork 和删除 Session；
- `SessionError`：带有 `SessionErrorCode` 的会话错误。

### 类型

- Harness：`HarnessConfig`、`HarnessRunEnd`；
- Session：`SessionMetadata`、`SessionNode`、`SessionErrorCode`。

Harness 事件载荷使用 agent 包定义的 `AgentRunIdentity`，但 harness 入口不重新导出这个类型；
需要显式使用时从 `core/agent` 入口导入。
