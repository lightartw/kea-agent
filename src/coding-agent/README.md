Coding Agent 管理一个持久化 Project。一个 Project 拥有稳定的随机 ID、显示名、一组规范化绝对
源目录和一个 primary 目录；它管理一个 Project 下的全部 Session，每个打开的 Session 由独立
的 AgentHarness 驱动。

Coding Agent 给 Harness 提供完成代码任务所需的各种能力：

- coding system prompt；
- Tools：Bash、文件、Glob 和 Todo；
- 控制事件：如 permission listener；
- UI 接口：confirm、notify 和工具展示。

## 1. Project

```ts
interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directories: readonly string[];
  readonly primaryDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

- `directories` 是一个或多个规范化绝对目录；`primaryDirectory` 是其中默认使用的一个。
- Project 元数据持久化在 `<keaHome>/projects/<id>/project.json`，每次启动用
  `createProject()` 重新打开，同一 `id` 保持不变。
- 没有 `Workspace` 概念——`directories` 只是文件工具允许访问的边界，不是独立实体。

### 1.1 根目录发现

`createProject({ keaHome, directory?, cwd? })` 决定 Project 的根目录：

1. 先扫描已注册 Project；当 `initialCwd` 等于或位于某个已注册 `directories` 之下时，选择
   匹配该目录（嵌套时选最长最具体的一条）并复用该 Project。
2. 否则，显式提供的 `directory` 直接作为新 Project 的根目录（不 Git 遍历）。
3. 否则用 `git rev-parse --show-toplevel` 从 `initialCwd` 发现 work-tree 根；失败时回退为
   `initialCwd`。

Git 只影响发现。每个非 Git 根目录都有独立的 Project 和 Session 存储；同一目录被两个
Project 注册会报错。

## 2. 创建并继续最近的 Session

```ts
import { createModelRuntime } from "../core/ai/index.js";
import { createProject } from "./index.js";

const { runtime, modelConfig } = createModelRuntime();
const project = await createProject({
  keaHome: process.env.KEA_HOME,
  runtime,
  modelConfig,
});

const harness = await project.continueRecent();
await harness.prompt("修复测试失败");
```

`createProject()` 建立 Project 的 Session 入口、共享 `Events` 和默认 coding 能力，但不会提前
打开 Session。`continueRecent()` 打开最近更新的 Session；如果 Project 尚无历史，则按启动
`cwd` 创建一份。它返回可以直接 `prompt()`、`abort()` 或 `switchModel()` 的 `AgentHarness`。

## 3. Project API

```ts
interface Project extends ProjectInfo {
  readonly events: Events;
  listSessions(): Promise<readonly SessionInfo[]>;
  createSession(options?): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  update(input: UpdateProjectInput): Promise<ProjectInfo>;
  renderTool(input: ToolPresentationInput): string;
}
```

- `events` 是 Project 拥有的唯一 `Events` 实例，所有 Session 共享（见第 5 节）。
- `listSessions()` 返回按 `updatedAt` 从新到旧排列的 `SessionInfo`；没有 Session 时返回空数组。
- `createSession()` 用当前 `primaryDirectory` 创建 Session（`cwd: "."`），并返回绑定它的新
  Harness；`createSession({ cwd })` 从 `primaryDirectory` 解析并存储相对 cwd。
- `openSession(sessionId)` 打开指定 Session，并校验 header 的 `projectId`、已注册目录、
  目录包含关系和文件系统存在性；无效或损坏的 Session 错误原样传播。
- `continueRecent()` 打开列表中的第一份 Session；列表为空时在启动 `initialCwd` 创建。
- `update(input)` 原子地更新 name/directories/primaryDirectory 并持久化；更改 primary 不会
  改写已有 Session 文件。
- `renderTool(input)` 按工具名把 `call` / `result` 渲染成 UI 文本。

`AgentHarness.sessionId` 是 Harness 所绑定 Session 的只读标识。Harness 不持有 Repository，
也不负责切换 Session；再次选择 Session 会得到另一个 Harness，而不会改写已有 Harness。

## 4. Session 与 cwd

一份 Session 存储一个选中的 Project 目录（`directory`）加一个相对 `cwd`：

```ts
interface SessionInfo {
  readonly id: string;
  readonly projectId: string;
  readonly directory: string;   // Project 的一个绝对目录
  readonly cwd: string;         // 相对该目录
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

`createProject` 给每份 Session 的 Harness 以**解析后的绝对 cwd**，并把 Project 的完整
`directories` 交给 Coding Tools。相对文件路径从 Session `cwd` 解析，但允许访问任一 Project
目录；离开全部 Project 目录的路径被拒绝。切换 `primaryDirectory` 只影响之后创建的 Session。

## 5. 一份 Project，一个共享 Events

`createProject()` 构造**一个** `Events` 实例：

```ts
const events = new Events(config.onEventListenerError);
registerCodingEvents(events, interactions);
```

`createSession()`、`openSession()` 和 `continueRecent()` 每次组装 Harness 时都把这个**同一个**
实例交给新的 `AgentHarness`；Harness 把绑定后的 `StreamFn` 传给 `runAgentLoop()`。因此一份 Project 的全部
Session 共享同一套 listener 注册，而 `sessionId`（来自 `AgentRunIdentity`）区分它们属于哪份
Session：

```ts
project.events.on("agent/turn-end", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  render(input.message);
});
```

同时打开的 Session 依然拥有独立的可变 Tool、模型和 run 状态；它们共享的是 Project 配置、
共享的 `Events`、Permission listener、调用方依赖和工具展示规则。

## 6. 每份 Session 的 Harness 组装

每次 `createSession()`、`openSession()` 或 `continueRecent()` 分配 Harness 时，Coding Agent
都重新组装：

1. 根据 `session.metadata.cwd` 和 Project `directories`，为 Bash、read、write、edit、Glob 和
   Todo 建立新的 `AgentToolRegistry`；
2. 复用 Project 共享的 `Events`（Permission 等 coding listener 已注册其上）；
3. 把 system prompt 模板中的 `{{cwd}}`、`{{date}}` 替换成当前值；
4. 把选中的 Session、Runtime、模型配置、最终 system prompt、Tool Registry 和 Events 交给新的
   `AgentHarness`。

## 7. Bash、文件与 Glob

### Bash

`bash` 接收 `{ command: string }`，每次在 Session `cwd` 中启动一个新的非交互 Bash 进程，
并把标准输出和错误输出合并为文本结果。

执行使用同一份三级策略：

| 判断 | 例子 | 行为 |
| ---- | ---- | ---- |
| allow | `pwd`、`git status` | 直接执行 |
| ask | `rm file.txt`、`chmod 777` | permission listener 调用 `confirm()` |
| deny | `sudo`、`mkfs`、`rm -rf /` | 直接拒绝，不询问 UI |

Permission listener 注册在 `tools/pre-execute` 拦截上，使用完整策略；Bash Tool 自身再次
检查 deny 规则，避免绕过 listener 后执行硬拒绝命令。Bash 失败和非零退出码会成为
`isError: true` 的 Tool Result。

### 文件与 Glob

- `read_file` 读取相对路径，可用 `limit` 限制返回行数；
- `write_file` 写入完整内容，并按需创建父目录；
- `edit_file` 只替换第一次出现的精确文本，找不到时返回错误结果；
- `glob` 从 Session `cwd` 匹配文件，统一使用 `/` 分隔输出，无结果时返回 `(no matches)`。

文件路径经过 Project 目录边界检查（`safePath(cwd, directories, path)`），不能逃出全部
Project 目录。

## 8. 无状态 Todo 与 Session 持久化

`todo_write` 每次接收完整任务列表：

```ts
interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

interface TodoDetails {
  readonly todos: readonly TodoItem[];
}
```

Todo Tool 不保存上一次调用。它同时返回模型可见的 `content` 和程序可读的
`details: { todos }`；Harness 把整个 Tool Result 写入 Session。这样，恢复 Session 后模型仍能
从 `content` 看见列表，UI 或程序也能从 `details` 读取结构化数据。Todo 状态属于 Session，
不属于 Tool 实例或单次 run。

## 9. Interactions 与工具展示

控制事件是执行前的控制通道。默认 permission listener 处理 Bash 的 allow/ask/deny；ask 时通过
`CodingAgentInteractions.confirm()` 请求 UI 决策。没有传入 interactions 时使用
`NO_INTERACTIONS`，其 `confirm()` 总是返回 `false`。

```ts
interface CodingAgentInteractions {
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}
```

事实事件报告已经发生的事实。UI 订阅 `project.events`，把带 `sessionId` 的 `agent/tool-call`、
`agent/tool-result` 投影成 `ToolPresentationInput`，再交给 Project 级的展示入口：

```ts
project.events.on("agent/tool-result", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  console.log(project.renderTool({ type: "result", call: input.call, result: input.result }));
});
```

每个 `ToolDefinition` 可以提供 `CodingToolPresentation`。没有专用规则、规则返回
`undefined` 或规则抛错时，Coding Agent 使用通用文本；展示失败不会改变 Tool Result。

## 10. 源码结构

- `factory.ts`：`createProject()`、共享 Events、Project 生命周期和 Session 选择；
- `types.ts`：`CreateProjectConfig`；
- `events/factory.ts`、`events/builtin/permission.ts`：coding 控制事件（Permission）；
- `project/types.ts`：`Project`、`ProjectInfo`、更新/创建输入；
- `project/storage.ts`：Project 文件读写、注册表扫描和根目录发现；
- `coding-system-prompt.ts`：默认 coding system prompt；
- `tools/factory.ts`、`tools/definition.ts`、`tools/builtin/*`：内置 Tool；
- `ui/interactions.ts`、`ui/presentation.ts`：UI 交互与工具展示。

具体 UI 依赖 Coding Agent；Coding Agent 组装 Harness 和 Agent 能力；Harness 驱动 Agent；Agent
使用 AI。Coding Agent 不导入 `src/ui`。

## 11. 完整公共 API

以下清单与 `src/coding-agent/index.ts` 一致。

### 值

- `createProject`：创建或打开持久化 Project；
- `CODING_SYSTEM_PROMPT`：默认 coding system prompt；
- `NO_INTERACTIONS`：fail-closed 的无 UI interactions；
- `openOrCreateProject`、`persistProject`、`applyProjectUpdate`、
  `assertDirectoryOwnership`（Project 存储层）。

### 类型

- Project：`Project`、`ProjectInfo`、`OpenedProject`、`OpenProjectInput`、
  `UpdateProjectInput`、`CreateSessionOptions`、`CreateProjectConfig`；
- UI 交互：`CodingAgentInteractions`、`ConfirmationRequest`、`Notification`；
- Tool 展示：`CodingToolPresentation`、`ToolPresentationCall`、`ToolPresentationInput`；
- Tool 定义：`CodingToolContext`、`ToolDefinition`；
- Todo：`TodoItem`、`TodoDetails`。

内置 Tool/事件工厂、`toAgentTool()`、Bash policy 和 presentation registry 是包内实现，不是
稳定公共接口。
