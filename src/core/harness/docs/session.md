# Session：会话模型与持久化

`Session` 是通用 agent 的 session 能力,负责保存和恢复会话。它把一份会话表示为逻辑节点、当前
节点和元数据;调用方通过 `SessionRepository` 管理多份 Session,底层持久化由内部的
`SessionStorage` 完成。session-bound 的运行器 `AgentHarness` 如何使用 Session,见
[harness.md](./harness.md)。

## 核心概念

- `SessionNode` 是会话历史中的一个逻辑节点;
- `SessionMetadata` 是会话当前的身份和描述信息;
- `Session` 保存一份会话的节点、当前端点和元数据,并提供读取与修改行为;
- `SessionRepository` 创建、打开、列举、fork 和删除多份 Session;
- `SessionStorage` 是 Repository 内部使用的持久化接口,不从 Harness 包入口导出。

调用方主要使用 `Session` 和 `SessionRepository`。`SessionStorage`、`SessionRecord` 和 JSONL
格式只在理解持久化实现时才需要关注。

## Session

一个 `Session` 表示一份独立的逻辑会话。它保存以 `parentId` 连接的节点树,并用 `headId`
选择当前路径的端点。Harness 负责运行模型;Session 只负责会话状态,不选择或调用模型。

### SessionNode、head 与路径

`SessionNode` 有两种变体:

- `message` 保存一条 `AgentMessage`;
- `model_selection` 保存从该节点开始生效的模型选择。

每个节点都包含 Session 生成的 `id`、`parentId` 和 `createdAt`。根节点的 `parentId` 为 `null`;
其他节点指向自己的父节点。节点加入 Session 后不再修改。

`session.headId` 是当前端点。`session.path()` 从 head 沿 `parentId` 回到根,再返回根到 head
的有序路径;传入指定节点 ID 时返回根到该节点的路径;传入 `null` 返回空路径;未知 ID 抛出
`not_found`。

`session.nodes` 返回 Session 中的全部逻辑节点。当前实现用 `nodeById` 作为节点的唯一内存容器:
Map 的键用于按 ID 查找,值的插入顺序用于返回 `nodes`。

### SessionMetadata

`SessionMetadata` 保存 `id`、`title`、`cwd`、`createdAt` 和 `updatedAt`;fork 得到的 Session
还包含 `parentSessionId`。`title` 是 Session 级状态,不是节点。`cwd` 是解析后的绝对路径,
用于恢复这份会话对应的工作目录。

助手消息使用了哪个模型记录在 assistant `AgentMessage` 自身的 `model` 字段中;
`model_selection` 节点表示后续 Run 应选择哪个模型,两者不属于 SessionMetadata。

### 读取当前上下文

- `messages(nodeId?)` 读取指定路径上的 `message` 节点并返回消息;默认读取当前 head 路径;
- `modelSelection(nodeId?)` 从指定路径的末端向根扫描,返回最近的 `model_selection`,没有则
  返回 `null`;
- `nodes`、`path()` 和 `messages()` 每次返回新的数组。

Harness 通过 `messages()` 恢复模型上下文,通过 `modelSelection()` 恢复当前模型选择。

### 修改 Session

`append()` 接收调用方提供的节点内容,Session 自己补齐节点身份和父子关系:

```ts
const nodeId = await session.append({
  type: "message",
  message: { role: "user", content: "hello" },
});
```

追加模型选择使用同一个方法:

```ts
await session.append({
  type: "model_selection",
  selection: { provider: "openai", model: "gpt-5" },
});
```

`setTitle()` 修改当前标题。所有修改都先等待 Storage 接受,再更新 Session 内存;持久化失败
不会发布新的节点、head 或标题。

### 内部状态与修改顺序

Session 的私有状态各自只有一个职责:

- `nodeById` 是节点的唯一内存容器,同时支持按 ID 查找和按插入顺序遍历;
- `_headId` 指向当前路径端点;
- `metadataState` 保存当前元数据;
- `storage` 指向 Repository 共享的 Storage;内存 Session 没有 Storage。

### 与 AgentHarness 的边界

`AgentHarness` 构造时接收调用方提供的 Session。它读取 `messages()` 和
`modelSelection()`,通过 `append()` 写入消息和模型选择,通过 `setTitle()` 修改标题。
`harness.sessionId` 和 `harness.title` 来自 `session.metadata`;Harness 不暴露可写的 Session
对象。

## SessionRepository

一个 Project 对应一个 `SessionRepository`。Repository 拥有一个 `SessionStorage`,并负责把
Storage 返回的 `{ metadata, nodes }` 构造成可用的 Session。它不直接读写文件,也不解析
JSONL。

### 创建、打开、列举和删除

```ts
const sessions = new SessionRepository(storageDir);
const session = await sessions.create({ cwd: process.cwd() });
const reopened = await sessions.open(session.id);
const metadata = await sessions.list();
await sessions.delete(session.id);
```

- `create({ cwd })` 生成 metadata 和空节点列表,等待 Storage 创建持久化数据,再返回 Session;
- `open(id)` 从 Storage 取得 metadata 和 nodes,再恢复 Session;
- `list()` 按存储的 `updatedAt` 从新到旧返回 `SessionMetadata[]`(相同时间按 ID 降序),
  空目录返回空数组;
- `delete(id)` 幂等删除一份 Session;目标不存在也视为成功。

Repository 持久创建成功后才构造 Session,因此不会返回一份尚未创建对应存储的对象。

### fork

`fork(sourceSessionId, nodeId)` 打开源 Session,取得根到 `nodeId` 的路径,用这组节点创建一份
新的 Session。新 Session 使用新的 ID 和时间,并在 metadata 中记录 `parentSessionId`:

```ts
const fork = await sessions.fork(session.id, session.headId);
```

节点保留原来的 ID 和 `parentId`,但源 Session 的标题记录和路径外的兄弟节点不会复制。
`nodeId` 为 `null` 时创建空 Session。删除源 Session 不影响已经创建的 fork。

### 内部边界

Repository 只编排生命周期:

- `create()` 和 `fork()` 先调用 `storage.create()`,再调用 `Session.fromStorage()`;
- `open()` 把 `storage.load()` 的结果交给 `Session.fromStorage()`;
- `list()` 和 `delete()` 直接委托给 Storage。

`AgentHarness` 不持有 Repository。应用先用 Repository 取得 Session,再把 Session 交给
Harness。

## SessionStorage

`SessionStorage` 是内部持久化接口。一个 Repository 持有一个 Storage,该 Storage 管理多份
Session。接口只有 `create/load/list/append/delete`,其中 `create/load` 在边界上交换逻辑的
`metadata` 和 `nodes`。

### SessionRecord

`SessionRecord` 是 Storage 接受和解析的一条持久化记录:

- `message` 和 `model_selection` 记录同时也是 `SessionNode`;
- `session_title` 表示标题变化,只用于持久化,不是节点。

Session 的内存状态不保存 `SessionRecord[]`。Storage 加载数据时把标题记录折叠进当前 metadata,
只把逻辑 nodes 返回给 Session。Session 修改标题时会把一次标题变化交给 Storage;Storage 接受后,
Session 只更新 `metadataState`。

### 创建、加载与追加

创建一份持久化 Session:

1. Repository 构造 `{ metadata, nodes: [] }`;
2. Storage 校验并持久化 metadata 和 nodes;
3. Repository 用同一份逻辑数据构造 Session。

重新打开一份 Session:

1. Storage 读取并解析全部持久化记录;
2. Storage 校验节点关系,把最后的标题和最新时间折叠进 metadata;
3. Storage 返回 `{ metadata, nodes }`;
4. Repository 用它构造 Session。

追加节点或标题:

1. Session 构造并校验一条完整记录;
2. `Storage.append()` 持久接受该记录;
3. Session 更新对应的节点、head 或 metadata。

### JsonlSessionStorage

文件位于 `<storageDir>/sessions/<sessionId>.jsonl`。第一行是 version-2 header
(`type: "session"`、`version: 2`、`id`、`cwd`、`title`、`createdAt`,fork 时还有
`parentSessionId`);后续每行是一条 `SessionRecord`。version-1 文件被显式拒绝。

`create()` 先写入临时文件,再通过 rename 发布最终文件;`load()` 校验 header、文件名、记录和
节点树;`list()` 忽略隐藏文件、临时文件和非 JSONL 文件,但不会静默忽略损坏的 Session;
`delete()` 只删除指定 Session 文件。

解析或树结构错误分别使用 `invalid_session`、`invalid_record`;文件系统失败使用 `storage`;
目标不存在使用 `not_found`。
