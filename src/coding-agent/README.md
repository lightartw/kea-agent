Coding Agent 管理一个代码 Project。一个 Project 包含工作目录和一组 Session；每个打开的
Session 由独立的 AgentHarness 驱动。

Coding Agent 给 Harness 提供完成代码任务所需的各种能力：

- coding system prompt；
- Tools：Bash、文件、Glob 和 Todo；
- Hooks：如 permission Hook；
- UI 接口：confirm、notify 和工具展示。

## 1. CodingProject

```ts
interface CodingProject {
  readonly workDir: string;
  readonly storageDir: string;
}
```

- `workDir` 是代码工具的项目根目录。相对文件路径、Glob 和 Bash 都从这里开始。
- `storageDir` 保存这个 Project 的全部 Session；`SessionRepository` 在其中创建、打开和列举
  Session。

`createCodingAgent()` 会把两个目录解析成绝对路径。Project 是 Coding Agent 的核心单位：
`CodingAgent` 在 Project 范围内选择 Session，Harness 只运行已经选中的一份 Session。

## 2. 创建并继续最近的 Session

```ts
import { createStreamFn } from "../ai/index.js";
import { createCodingAgent } from "./index.js";

const { stream, defaultModel } = createStreamFn();
const codingAgent = await createCodingAgent({
  project: {
    workDir: process.cwd(),
    storageDir: ".kea",
  },
  streamFn: stream,
  model: defaultModel,
});

const harness = await codingAgent.continueRecent();
await harness.prompt("修复测试失败");
```

`createCodingAgent()` 建立 Project 级的 Session 入口和默认 coding 能力，但不会提前打开
Session。`continueRecent()` 打开最近修改的 Session；如果 Project 尚无历史，则创建一份。
它返回可以直接 `prompt()`、`subscribe()`、`abort()` 或 `switchModel()` 的 `AgentHarness`。

## 3. 选择 Session

```ts
interface CodingAgent {
  listSessions(): Promise<readonly string[]>;
  createSession(): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  renderToolEvent(event: HarnessToolEvent): string;
}
```

- `listSessions()` 返回按文件最近修改时间从新到旧排列的 Session ID；没有 Session 时返回空数组。
- `createSession()` 创建 Session，并返回绑定它的新 Harness。
- `openSession(sessionId)` 打开指定 Session，并返回绑定它的新 Harness；无效或损坏的 Session
  错误会原样传播。
- `continueRecent()` 打开列表中的第一份 Session；列表为空时创建 Session。

`AgentHarness.sessionId` 是 Harness 所绑定 Session 的只读标识。Harness 不持有 Repository，
也不负责切换 Session；再次选择 Session 会得到另一个 Harness，而不会改写已有 Harness。

## 4. 每份 Session 的 Harness 组装

`createSession()`、`openSession()` 和 `continueRecent()` 每次返回 Harness 时都会重新组装：

1. 为 Bash、read、write、edit、Glob 和 Todo 建立新的 `AgentToolRegistry` 与 Tool 实例；
2. 为 permission Hook 建立新的 `HookRegistry`；
3. 把选中的 Session、模型、stream、system prompt 和 `workDir` 交给新的 `AgentHarness`；
4. Harness 自己建立 Event Bus、消息视图、当前模型、AbortController 和运行状态。

因此同时打开的 Session 拥有独立的可变 Tool、Hook、Event、模型和 run 状态。它们共享的是
Project 配置、调用方依赖和工具展示规则，不共享当前 Harness 或当前 Session 状态。

## 5. Bash、文件与 Glob

### Bash

`bash` 接收 `{ command: string }`，每次在 `workDir` 中启动一个新的非交互 Bash 进程，并把
标准输出和错误输出合并为文本结果。进程之间不保留 shell 变量或工作目录变更。

执行使用同一份三级策略：

| 判断 | 例子 | 行为 |
| ---- | ---- | ---- |
| allow | `pwd`、`git status` | 直接执行 |
| ask | `rm file.txt`、`chmod 777` | permission Hook 调用 `confirm()` |
| deny | `sudo`、`mkfs`、`rm -rf /` | 直接拒绝，不询问 UI |

Permission Hook 使用完整策略；Bash Tool 自身再次检查 deny 规则，避免绕过 Hook 后执行硬拒绝
命令。Bash 失败和非零退出码会成为 `isError: true` 的 Tool Result。

### 文件与 Glob

- `read_file` 读取相对路径，可用 `limit` 限制返回行数；
- `write_file` 写入完整内容，并按需创建父目录；
- `edit_file` 只替换第一次出现的精确文本，找不到时返回错误结果；
- `glob` 从 `workDir` 匹配文件，统一使用 `/` 分隔输出，无结果时返回 `(no matches)`。

文件路径经过 workspace 边界检查，不能用相对路径逃出 `workDir`。

## 6. 无状态 Todo 与 Session 持久化

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

## 7. Hook、Interactions、Harness Event 与展示

Hook 是执行前的控制通道。默认 permission Hook 处理 Bash 的 allow/ask/deny；ask 时通过
`CodingAgentInteractions.confirm()` 请求 UI 决策。没有传入 interactions 时使用
`NO_INTERACTIONS`，其 `confirm()` 总是返回 `false`，所以需要确认的操作默认拒绝。

```ts
interface CodingAgentInteractions {
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}
```

`notify()` 用于无需回复的诊断。目前工具展示规则抛错时，Coding Agent 通过它报告错误；通知
失败不会重新进入 Tool 执行。

Harness Event 报告已经发生的事实。UI 订阅具体 Harness，自己处理文本流和 run 生命周期，
并把 `tool_start`、`tool_end`、`tool_rejected` 交给 Project 级的展示入口：

```ts
const unsubscribe = harness.subscribe((event) => {
  if (
    event.type === "tool_start" ||
    event.type === "tool_end" ||
    event.type === "tool_rejected"
  ) {
    console.log(codingAgent.renderToolEvent(event));
  }
});
```

每个 `CodingToolDefinition` 可以提供 `CodingToolPresentation`。没有专用规则、规则返回
`undefined` 或规则抛错时，Coding Agent 使用通用文本；展示失败不会改变 Tool Result。
Hook 可以阻止尚未执行的操作，Interactions 让 Coding Agent 请求 UI 动作，Harness Event 和
presentation 只负责观察与展示。

## 8. 源码结构

- `factory.ts`：Project 级 `CodingAgent`、Session 选择和 Harness 组装；
- `types.ts`：`CodingProject`、工厂配置和 `CodingAgent`；
- `coding-system-prompt.ts`：默认 coding system prompt；
- `hooks/factory.ts`：组装 Coding Agent 默认 Hooks；
- `hooks/permission.ts`：Bash permission Hook；
- `tools/factory.ts`：组装内置 Tool definitions 和每个 Harness 独立的 Agent Tool Registry；
- `tools/definition.ts`：Coding Tool 定义及到 `AgentTool` 的内部转换；
- `tools/builtin/bash.ts`、`bash-policy.ts`：本地 Bash 与共享安全策略；
- `tools/builtin/files.ts`：read、write、edit 和 Glob；
- `tools/builtin/todo.ts`：Todo 类型、执行和展示；
- `ui/interactions.ts`：confirm、notify 与无 UI 默认实现；
- `ui/presentation.ts`：工具展示契约、选择和 fallback。

具体 UI 依赖 Coding Agent；Coding Agent 组装 Harness 和 Agent 能力；Harness 驱动 Agent；Agent
使用 AI。Coding Agent 不导入 `src/ui`。

## 9. 完整公共 API

以下清单与 `src/coding-agent/index.ts` 一致。

### 值

- `createCodingAgent`：创建 Project 级 `CodingAgent`；
- `CODING_SYSTEM_PROMPT`：默认 coding system prompt；
- `NO_INTERACTIONS`：fail-closed 的无 UI interactions。

### 类型

- Project 与创建：`CodingAgent`、`CodingProject`、`CreateCodingAgentConfig`；
- UI 交互：`CodingAgentInteractions`、`ConfirmationRequest`、`Notification`；
- Tool 展示：`CodingToolPresentation`、`ToolPresentationCall`、
  `ToolPresentationRejected`；
- Tool 定义：`CodingToolContext`、`CodingToolDefinition`；
- Todo：`TodoItem`、`TodoDetails`。

内置 Tool/Hook 工厂、`toAgentTool()`、Bash policy 和 presentation registry 是包内实现，不是
稳定公共接口。
