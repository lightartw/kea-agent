# Coding Agent

`coding-agent` 将通用 Agent 层组装为可直接使用的 Coding Agent。它定义 UI port、Bash 安全策略、默认 Hook 组合，并通过 `createHarness` 暴露。

## 最小用法

```ts
import { createHarness } from "./coding-agent/index.js";
import { Session } from "./agent/harness/index.js";

const harness = await createHarness({
  project: { workDir: process.cwd(), storageDir: ".sessions" },
  streamFn,
  model,
  session: Session.inMemory(),
  ui: myUI, // 可选；未传入时 fail-closed
});

await harness.prompt("list files");
```

## 职责

- 将 `AgentHarness` 与 coding 工具集、coding system prompt 和默认 Hook 组装。
- 通过 `CodingHookUI` 注入权限确认能力，不产生 `coding-agent -> ui` 的源码依赖。
- UI 实现 `CodingHookUI` port；Coding Agent 永不导入 UI 代码。

## 默认 Hook：只有 permission

默认 `createCodingHookRegistry(context)` 只注册一个真正改变控制流的 Hook——permission。
被动的展示（log、大输出提醒、工具计数 summary）不再是 Hook，而是 UI 层针对
Harness `subscribe` 事件的 renderer 行为。

| Hook | 类型 | 行为 |
|------|------|------|
| Permission | `tool_call` Handler | Bash 命令的 allow/ask/deny 策略；ask 时调用 `ui.confirm()` |

## Bash 安全策略

位于 `bash-policy.ts`，是 Permission Hook 与 `BashTool` 共享的单一来源。

### 决策

| 级别 | 示例 | 行为 |
|------|------|------|
| 硬拒绝 | `sudo`、`shutdown`、`mkfs`、`dd if=`、`> /dev/`、`rm -rf /` | Hook 和 BashTool 均阻止；不询问 UI |
| 询问 | `rm`、`> /etc/`、`chmod 777` | Permission Hook 调用 `ui.confirm()` |
| 允许 | `pwd`、`git status`、`npm test` | 直接放行 |

### Fail-closed

- 无 UI 或 `ui.available === false` → 询问类命令被拒绝。
- 用户拒绝 → 拒绝。
- `confirm()` 抛出异常 → 拒绝。
- 外部 `AbortSignal` 已触发时，Agent Loop 优先归类为 `aborted`，不归类为 `blocked`。

## `CodingHookUI`

通用但严格受限的 UI port。`source` 是稳定来源标识，不建立封闭的 Hook 名称联合。

```ts
interface CodingHookUI {
  readonly available: boolean;
  confirm(confirmation: HookConfirmation, signal?: AbortSignal): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}

interface HookConfirmation {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

interface HookNotification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}
```

`notify()` 只用于 Hook 自己产生、没有对应运行 Event 的即时说明；普通工具开始/结束、
工具结果、工具计数和大输出提醒都走 Harness `subscribe`，不经 `notify()`。

## `createCodingHookRegistry`

```ts
function createCodingHookRegistry(
  context: CodingHookContext,
): HookRegistry<CodingHookContext>;
```

创建预配置了 permission Hook 的 Registry。可用于自定义组合场景。

```ts
interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}
```

## 工具与 Todo 状态

默认工具集由 `createToolRegistry(cwd)` 创建：`bash`、`read_file`、`write_file`、
`edit_file`、`glob`、`todo_write`。

`todo_write` 是无状态工具。每次调用返回完整列表，`content`（模型可见）与
`details.todos`（程序可见）由同一输入派生：

```ts
interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

interface TodoDetails {
  readonly todos: readonly TodoItem[];
}

function formatTodoContent(todos: readonly TodoItem[]): string;
function findLatestTodoDetails(messages: readonly AgentMessage[]): TodoDetails | undefined;
```

Todo 的真实状态定义为「当前 Session 分支中最后一条有效 `todo_write` ToolResultMessage 的
`details.todos`」，由 `findLatestTodoDetails` 投影，位于 coding-agent 而非具体 UI。
重启、恢复和 switchModel 后新模型都能从 Provider 可见的 `content` 恢复完整列表。

## 完整公开导出

从 `src/coding-agent/index.ts`：

- `createHarness`、`createCodingHookRegistry`、`createToolRegistry`
- `CODING_SYSTEM_PROMPT`
- `CreateHarnessConfig`、`CodingHookContext`、`CodingHookUI`
- `HookConfirmation`、`HookNotification`
- `TodoItem`、`TodoDetails`

## 内部实现

以下名称仅供 coding-agent 内部使用，不作为稳定公共 API：

- `NO_HOOK_UI` — 默认 fail-closed UI 实现（不 root-export）
- `registerPermissionHook`
- `classifyBashCommand`、`hardDeniedBashReason`

## 依赖方向

```text
ui
    │ 实现 CodingHookUI；通过 subscribe 渲染
    ▼
coding-agent
    │ 创建默认 HookRegistry（只向下传 AgentHookTrigger）
    ▼
agent/harness
    │ 原样传递
    ▼
agent-loop
    │ 在控制点触发 Hook
    ▼
ai / tool registry
```

源码依赖始终向下：`ui -> coding-agent -> agent -> ai`。运行时 `PermissionHook -> injected
CodingHookUI` 是依赖倒置后的接口调用。
