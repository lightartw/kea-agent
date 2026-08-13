# Project、Session Repository 与 README 重构设计

> 后续设计说明：`2026-08-13-project-directories-session-format-design.md` 已取代本文中的
> `CodingProject`、Session 当前格式、延迟创建文件和只返回 Session ID 的列表设计。

## 目标

用每一层处理的核心单位解释系统，并让代码边界与这套叙事一致：

- `ai` 完成一次 LLM 请求；
- `agent-loop` 完成一次 Agent Run；
- `AgentHarness` 驱动一个 Session，在其中执行多次 Run；
- `CodingAgent` 管理一个代码 Project，并为 Project 中的 Session 创建具备代码能力的 Harness。

本次修改拆开单个 Session 的运行与多个 Session 的发现，随后重写 Harness 和 Coding Agent
README。不会增加 Session Runtime、Project Manager 或 Repository 接口/实现双层。

## Harness

### Session

`Session` 表示一个会话的持久数据。它保存消息、模型变更和当前分支，并能通过
`buildContext()` 恢复模型上下文。它不执行 Agent，也不知道 Tool、Hook 和 UI。

`Session.inMemory()` 继续用于测试和无需持久化的调用者。磁盘 Session 仍采用当前 JSONL
格式。

### SessionRepository

当前 `SessionManager` 实际管理一个存储目录中的多个 Session，因此改名为
`SessionRepository`：

```ts
class SessionRepository {
  constructor(storageDir: string);

  create(): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly string[]>;
}
```

`list()` 返回按最近修改时间排列的 Session ID。当前没有元数据消费者，因此不增加
`SessionMetadata`。当前也只有一种存储实现，因此不同时定义 Repository 接口和 JSONL 实现类。

Repository 只提供创建、打开和列举原语。“没有历史时创建一个 Session”是产品策略，由
Coding Agent 的 `continueRecent()` 实现。

源码调整：

```text
src/harness/session/manager.ts
→ src/harness/session/repository.ts
```

`SessionManager` 从公共入口删除，新增 `SessionRepository`。

### AgentHarness

一个 `AgentHarness` 始终绑定一个已经打开的 `Session`。它负责：

- `prompt()` 启动一次 Agent Run；
- 将新消息和模型变更写入 Session；
- abort 和模型切换；
- 发布 `HarnessEvent`；
- 持有当前 Session 的 Tool、Hook 和运行状态。

Harness 公开只读 `sessionId`，使调用者可以标识当前 Harness 绑定的 Session，而不暴露可写的
`Session` 对象：

```ts
get sessionId(): string;
```

`sessionId` 不改变 Session 的持久化时机。当前磁盘 Session 仍在第一次 assistant 消息产生后
创建文件；空 Session 是否出现在 Repository 列表中属于独立的持久化语义。

Harness 不持有 `SessionRepository`，也不选择 Session。上层先通过 Repository 获得 Session，
再用 Session 创建 Harness。

### 删除 HarnessProject

`HarnessProject` 混合了两个不同概念：

- `workDir` 是 Coding Project 的属性；
- `storageDir` 是 Session Repository 的配置。

Harness 不理解代码项目，因此删除 `HarnessProject`。`HarnessConfig.cwd` 仍然保留，因为
system prompt 等通用 Harness 能力需要当前工作目录，但它不再被包装成 Project。

## Coding Agent

### CodingProject

Coding Agent 定义项目边界：

```ts
interface CodingProject {
  readonly workDir: string;
  readonly storageDir: string;
}
```

`workDir` 是 Bash、文件和 Glob 的工作目录；`storageDir` 是这个 Project 的 Session 存储目录。

### CodingAgent

`createCodingAgent()` 返回项目级 `CodingAgent`：

```ts
interface CodingAgent {
  listSessions(): Promise<readonly string[]>;
  createSession(): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  renderToolEvent(event: HarnessToolEvent): string;
}
```

`CodingAgent` 是公开契约，不额外增加公开实现类。工厂在包内创建 Repository、Tool
definitions、Hook 组装规则和 presentation，再返回实现该契约的对象。

保留 `createCodingAgent()` 工厂函数。它隐藏 Repository、Tool/Hook Registry 和 presentation
的组装，并为以后增加配置加载保留稳定入口。

`CodingAgent` 不保存 `currentHarness`。Session 选择属于调用者或 UI；创建和打开方法直接返回
`AgentHarness`。因此不需要定义 Session Runtime，也不会引入 Session 切换时的隐式资源所有权。

### Session 操作

- `listSessions()` 调用 Repository 的 `list()`。
- `createSession()` 创建 Session，然后组装并返回 Harness。
- `openSession(id)` 打开 Session，然后组装并返回 Harness。
- `continueRecent()` 打开 `list()` 返回的第一个 Session；列表为空时创建 Session。

后三个方法复用同一个包内 `createHarness(session)` 函数。每个 Harness 获得独立的 Tool
Registry、Hook Registry、Event Bus、模型状态和运行状态。Project 配置与不可变 Tool
definitions 可以共享。

同一 Session 的多写入者保护最终属于 Session Repository；本次不增加进程内 Harness 缓存来
间接实现该约束。

### Coding Agent 提供的能力

Coding Agent 为每个 Harness 组装：

- coding system prompt；
- Bash、read、write、edit、Glob 和 Todo Tools；
- permission Hook；
- `confirm`、`notify` interactions；
- Tool Event presentation。

Tools 和 Hooks 的执行状态属于各自的 Harness。Todo Tool 本身无状态；完整列表同时出现在
模型可见的 `content` 和程序可见的 `details.todos` 中，并随工具结果保存在 Session。

### 创建方式

```ts
const codingAgent = await createCodingAgent({
  project: {
    workDir: process.cwd(),
    storageDir: ".kea",
  },
  streamFn,
  model,
  interactions,
});

const harness = await codingAgent.continueRecent();
await harness.prompt("修复失败的测试");
```

当前 `CreateCodingAgentConfig.session` 删除。Session 由 `CodingAgent` 的 Session 方法选择。
当前 `CodingAgentRuntime` 删除，由项目级 `CodingAgent` 取代。

## README 重写

### Harness README

README 按以下顺序渐进讲解：

1. 核心单位：LLM 请求、Agent Run、Session 和 Harness；
2. 使用内存 Session 的最小 Harness 示例；
3. 一次 `prompt()` 的完整行为；
4. Session 保存的内容和恢复方式；
5. SessionRepository 如何创建、打开和列举多个 Session；
6. Event Bus 的 Event、Listener、`subscribe()` 和 `publish()`；
7. Harness 如何消费模型、Tool、Hook、system prompt 和 cwd；
8. 文件结构和完整公共接口。

开头必须明确：Session 是数据，Harness 是驱动一个 Session 的运行引擎，Repository 管理多个
Session。README 不介绍尚未实现的多 Lane、持久化 Operation 或崩溃恢复。

### Coding Agent README

README 假设读者已经理解 Harness，按以下顺序展开：

1. Coding Agent 管理一个代码 Project；
2. Coding Agent 给 Harness 提供的 system prompt、Tools、Hooks 和 UI 接口；
3. `CodingProject` 的 `workDir` 与 `storageDir`；
4. 创建 Coding Agent 并通过 `continueRecent()` 获得 Harness；
5. 创建、列举、打开和恢复 Session；
6. 为一个 Session 组装 Harness 的过程；
7. Bash、文件和 Glob；
8. Todo 的无状态执行与 Session 持久化；
9. Hook、Interactions、Harness Event 和 Presentation 的分工；
10. 文件结构和完整公共接口。

开场采用直接叙事：

> Coding Agent 给 Harness 提供完成代码任务所需的各种能力：
>
> - coding system prompt；
> - Tools：Bash、文件、Glob 和 Todo；
> - Hooks：如 permission Hook；
> - UI 接口：confirm、notify 和工具展示。

两篇 README 不使用图像或调用图，不用“不再……只……”一类依赖讨论上下文的对比句式。
每个概念第一次出现时说明其职责，所有示例只使用真实公共 API。

## 公共接口迁移

Harness：

- 删除 `SessionManager`；
- 删除 `HarnessProject`；
- 新增 `SessionRepository`。

Coding Agent：

- 删除 `CodingAgentRuntime`；
- 新增 `CodingAgent`；
- 新增 `CodingProject`；
- `CreateCodingAgentConfig` 不再接收 `session`；
- `createCodingAgent()` 返回 `Promise<CodingAgent>`。

根入口、测试、主程序、架构文档以及所有 README 示例同步迁移，不保留旧类型别名。

## 错误与状态规则

- Repository 的存储、找不到 Session 和无效 Session 错误继续使用 `SessionError`。
- `openSession()` 原样传播 Repository 错误。
- `continueRecent()` 只在列表为空时创建 Session；列表中的最近 Session 无法打开时传播错误，
  不静默创建新 Session。
- 为 Session 组装 Harness 失败时不缓存半成品。
- 一个 Harness 的 Hook、Tool 和 Event 状态不能泄漏到另一个 Harness。

## 测试与验收

1. Repository 能创建、列举并打开 Session，`list()` 按修改时间排序。
2. Harness 的 `sessionId` 等于其绑定 Session 的 ID，且不公开可写 Session。
3. `continueRecent()` 在空 Repository 中创建 Session，有历史时打开最近 Session。
4. `createSession()` 和 `openSession()` 返回的 Harness 带有完整的 coding Tools、permission Hook
   和 presentation。
5. 两个 Harness 不共享可变 Tool、Hook、Event 或模型状态。
6. Project `workDir` 继续约束 Bash、文件和 Glob。
7. CLI 通过 Coding Agent 选择 Session，再运行返回的 Harness。
8. `SessionManager`、`HarnessProject`、`CodingAgentRuntime` 和旧路径没有残留引用。
9. Harness 与 Coding Agent README 的接口清单分别与对应 `index.ts` 完全一致。
10. TypeScript 类型检查和全部测试通过。
