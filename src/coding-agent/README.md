# Coding Agent — 让 Harness 能在代码项目中工作

读到这里前，应先理解 Harness：Harness 管理 Session 和一次次 run，并通过
`HarnessEvent` 报告运行事实。

Coding Agent 不再建立一套运行系统。它只给 Harness 装上完成代码任务所需的默认能力：

- coding system prompt；
- Bash、文件、Glob 和 Todo 工具；
- Bash 权限 Hook；
- 两个 UI 接口：向用户提问，以及把工具事件转换为展示文本。

所以 Coding Agent 的核心可以概括为：**输入一个项目和 Harness 所需依赖，输出一个已经装好
coding 能力的 Harness。**

## 1. Project

Coding Agent 围绕一个 `HarnessProject` 工作：

```ts
interface HarnessProject {
  readonly workDir: string;
  readonly storageDir: string;
}
```

- `workDir` 是工具操作的项目根目录。相对文件路径、Glob 和 Bash 都以它为起点。
- `storageDir` 是这个项目的 Session 存储目录；创建或恢复 Session 时使用。

Coding Agent 不负责选择 Session。调用者先创建或恢复 Session，再把它和 Project 一起传入。

## 2. 创建并运行

```ts
import { createCodingAgent } from "./coding-agent/index.js";
import { Session } from "./harness/index.js";

const runtime = await createCodingAgent({
  project: {
    workDir: process.cwd(),
    storageDir: ".kea",
  },
  streamFn,
  model,
  session: Session.inMemory(),
  interactions: myInteractions, // 可选
});

await runtime.harness.prompt("修复测试失败");
```

`createCodingAgent()` 返回的 `CodingAgentRuntime` 只有两项能力：

```ts
interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly renderToolEvent: (event: HarnessToolEvent) => string;
}
```

- `harness` 是唯一的运行入口：prompt、abort、切换模型、读取消息、订阅事件都在这里。
- `renderToolEvent()` 把一个工具事件转换为可展示文本。UI 不会得到内部注册表，也不能修改
  Coding Agent 已经组装好的展示规则。

## 3. 一次运行如何经过 Coding Agent

假设模型请求执行 `bash({ command: "rm old.txt" })`：

1. Harness 驱动 Agent Loop，Agent 收到模型产生的 Tool Call。
2. Permission Hook 在执行前检查命令。`rm` 需要确认，因此通过 `interactions.confirm()` 询问
   UI。
3. 用户允许后，Agent 验证参数并执行 Bash Agent Tool。
4. 工具返回 `AgentToolResult`；Agent 将结果写入消息，Harness 将消息持久化到 Session。
5. Harness 发布 `tool_start` 和 `tool_end` 等事实。UI 订阅这些 Event。
6. UI 把工具 Event 交给 `runtime.renderToolEvent()`，再决定输出到终端、TUI 或其他界面。

这条链中，Hook 可以改变尚未提交的行为；Harness Event 只能报告已经发生的事实；UI 只在
Coding Agent 以上出现。

## 4. 为什么有 `CodingToolDefinition`

Agent 层只需要知道工具怎样验证和执行，因此定义 `AgentTool`。Coding Agent 还需要知道一个
工具怎样展示，例如 Todo 结果适合显示成任务列表。

`CodingToolDefinition` 把同一个 coding 工具的两部分放在一起：

```ts
interface CodingToolDefinition<TParameters, TDetails> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;

  execute(arguments_, signal, context): Promise<AgentToolResult<TDetails>>;
  readonly presentation?: CodingToolPresentation<arguments_, TDetails>;
}

interface CodingToolContext {
  readonly cwd: string;
}
```

创建 Runtime 时，Coding Agent 在包内完成一次翻译：

- schema 和 `execute()` 变成 `AgentTool`，向下交给 Agent；
- 可选 `presentation` 留在 Coding Agent，向上供 UI 使用。

因此 Agent 和 Harness 都不会依赖 UI，同时一个具体工具的执行语义和展示语义仍能放在同一
处维护。这是 Coding Agent 保留的主要翻译层。

## 5. Bash 工具

Bash 接收 `{ command: string }`，在 Project 的 `workDir` 中启动本地非交互 Bash，并将标准
输出和错误输出合并为文本结果。每次调用都会启动新进程；上一次命令设置的 shell 变量不会
成为下一次调用的隐藏状态。

执行前使用三级策略：

| 判断 | 例子 | 结果 |
|------|------|------|
| allow | `pwd`、`git status` | 直接执行。 |
| ask | `rm file.txt`、`chmod 777` | Permission Hook 调用 `confirm()`。 |
| deny | `sudo`、`mkfs`、`rm -rf /` | 直接拒绝，不询问 UI。 |

共享策略独立放在 `bash-policy.ts`，因为它有两个真实调用者：

- Permission Hook 用完整的 allow/ask/deny 规则决定是否询问用户；
- Bash 工具自身再次检查 deny 规则，防止工具绕过 Hook 后执行绝不允许的命令。

本地进程执行没有额外 backend interface。目前只有一种实现；真正出现 SSH 或容器执行时，
再根据两个真实实现抽取接口。

## 6. Todo 工具与状态

`todo_write` 每次接收完整任务列表：

```ts
interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}
```

它不会记住上一次调用，而是根据本次输入同时返回：

```ts
{
  content: "Current tasks:\n1. [in_progress] 修复测试\nUpdated 1 tasks",
  details: { todos: [...] },
  isError: false,
}
```

- `content` 会进入下一次模型请求，所以模型在恢复 Session 或切换模型后仍能看到任务列表。
- `details.todos` 保存在 Agent 消息和 Session 中，程序或 UI 可以读取结构化列表。

因此 Todo 的可恢复状态属于 **Session**，不属于一次 run，也不藏在 Todo Tool 实例里。
当前没有常驻 Todo 面板，所以 Coding Agent 不预先提供状态查询类；出现真实 UI 消费者后，
再在 Todo 模块中增加从当前 Session 分支读取列表的函数。

## 7. Interactions 与工具展示

这两种 UI 接口方向不同。

### Interactions：Coding Agent 向 UI 请求动作

```ts
interface CodingAgentInteractions {
  confirm(request, signal?): Promise<boolean>;
  notify(notification): void | Promise<void>;
}
```

`confirm()` 会影响控制流，例如决定是否执行 `rm`。没有传入 interactions 时使用
`NO_INTERACTIONS`，其 `confirm()` 始终返回 `false`，所以需要确认的命令默认拒绝。

`notify()` 用于不需要回复的通知和诊断。它不等于 Harness Event，也不能改变 Agent 行为。

### Event 与 presentation：UI 消费已经发生的事实

UI 调用 `runtime.harness.subscribe()` 接收全部 `HarnessEvent`。文本流、run 生命周期和统计由
UI 自己展示；三个工具执行事件可以交给 `renderToolEvent()`：

```ts
if (
  event.type === "tool_start" ||
  event.type === "tool_end" ||
  event.type === "tool_rejected"
) {
  console.log(runtime.renderToolEvent(event));
}
```

具体工具可以提供 `CodingToolPresentation`；没有专用规则、规则返回 `undefined` 或展示代码抛错
时，Coding Agent 使用通用文本。展示失败只产生诊断，不会改变工具执行结果。

## 8. 源码结构

```text
src/coding-agent/
  factory.ts                 createCodingAgent；默认能力清单和组装
  types.ts                   工厂输入与 Runtime 输出
  coding-system-prompt.ts    默认 coding system prompt
  hooks/
    permission.ts            Bash Permission Hook
  tools/
    definition.ts            CodingToolDefinition 及到 AgentTool 的内部翻译
    builtin/
      bash.ts                Bash schema 与本地执行
      bash-policy.ts         两个调用者共享的安全策略
      files.ts               read、write、edit、glob
      todo.ts                Todo 类型、执行与 presentation
  ui/
    interactions.ts          confirm、notify 与无 UI 默认实现
    presentation.ts          展示契约与内部选择/fallback
```

依赖方向是：具体 UI 使用 Coding Agent；Coding Agent 组装 Harness 和 Agent 能力；Harness 驱动
Agent；Agent 使用 AI。Agent 和 Harness 都不知道 Coding Agent 的 Project 默认能力或 UI。

## 9. 完整公共 API

普通消费者从 `src/coding-agent/index.ts` 导入以下内容。

### 值

- `createCodingAgent`
- `CODING_SYSTEM_PROMPT`
- `NO_INTERACTIONS`

### 创建与 UI 类型

- `CreateCodingAgentConfig`
- `CodingAgentRuntime`
- `CodingAgentInteractions`
- `ConfirmationRequest`
- `Notification`

### 自定义工具类型

- `CodingToolDefinition`
- `CodingToolContext`
- `CodingToolPresentation`
- `ToolPresentationCall`
- `ToolPresentationRejected`
- `TodoItem`
- `TodoDetails`

默认 Tool/Hook 工厂、AgentTool 翻译函数、Bash policy 和 presentation registry 都是包内实现，
不是稳定公共接口。普通使用者只需创建 Runtime，再通过其中的 Harness 和
`renderToolEvent()` 工作。
