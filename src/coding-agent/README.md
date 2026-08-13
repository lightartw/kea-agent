# Coding Agent

`coding-agent` 将通用 Agent 层组装为可直接使用的 Coding Agent。它定义交互 port、Bash
安全策略、默认 Hook 组合、Coding Tool 定义与 presentation，并通过 `createCodingAgent`
暴露运行时。

## 最小用法

```ts
import { createCodingAgent } from "./coding-agent/index.js";
import { Session } from "./harness/index.js";

const runtime = await createCodingAgent({
  project: { workDir: process.cwd(), storageDir: ".sessions" },
  streamFn,
  model,
  session: Session.inMemory(),
  interactions: myInteractions, // 可选；未传入时 fail-closed
});

await runtime.harness.prompt("list files");
```

## 职责

- 将 `AgentHarness` 与 Coding Tool 定义、coding system prompt 和默认 Hook 组装，返回 `CodingAgentRuntime`。
- 通过 `CodingAgentInteractions` 注入权限确认能力，不产生 `coding-agent -> ui` 的源码依赖。
- UI 实现 `CodingAgentInteractions` port；Coding Agent 永不导入 UI 代码。
- 运行时 UI 只知道 `CodingAgentRuntime`；Coding Agent 在**构造期**直接接触 `AgentTool` 与 `AgentHook` 契约。

## `CodingAgentInteractions`

通用但严格受限的交互 port。`source` 是稳定来源标识，不建立封闭的 Hook 名称联合。

```ts
interface CodingAgentInteractions {
  readonly available: boolean;
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}

interface ConfirmationRequest {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

interface Notification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}
```

`notify()` 只用于 Hook 自己产生、没有对应运行 Event 的即时说明；普通工具开始/结束、
工具结果、工具计数和大输出提醒都走 Harness `subscribe`，不经 `notify()`。

## 默认 Hook：只有 permission

默认 `createDefaultCodingHookRegistry(context)` 只注册一个真正改变控制流的 Hook——permission。
被动的展示（log、大输出提醒、工具计数 summary）不是 Hook，而是 UI 层针对 Harness
`subscribe` 事件的 renderer 行为。

| Hook | 类型 | 行为 |
|------|------|------|
| Permission | `tool_call` Handler | Bash 命令的 allow/ask/deny 策略；ask 时调用 `interactions.confirm()` |

```ts
interface CodingHookContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}
```

## Bash 安全策略

位于 `bash-policy.ts`，是 Permission Hook 与 `bash` 工具定义共享的单一来源。

| 级别 | 示例 | 行为 |
|------|------|------|
| 硬拒绝 | `sudo`、`shutdown`、`mkfs`、`dd if=`、`> /dev/`、`rm -rf /` | Hook 和 BashTool 均阻止；不询问 UI |
| 询问 | `rm`、`> /etc/`、`chmod 777` | Permission Hook 调用 `interactions.confirm()` |
| 允许 | `pwd`、`git status`、`npm test` | 直接放行 |

Fail-closed：无 interactions 或 `available === false` → 询问类命令被拒绝；用户拒绝 → 拒绝；
`confirm()` 抛出异常 → 拒绝；外部 `AbortSignal` 已触发时，Agent Loop 优先归类为 `aborted`。

## Coding Tool：一处定义、两个投影

工具在 coding-agent 定义一次，向两个方向投影：

- **向下**：`toAgentTool(definition, { cwd })` → `AgentTool`（进入 agent 层，无 renderer）。
- **侧向**：`CodingToolPresentationRegistry` 按工具名注册 `definition.presentation`，供 UI 渲染。

```ts
interface CodingToolDefinition<TParameters, TDetails> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(arguments_, signal, context: CodingToolContext): Promise<AgentToolResult<TDetails>>;
  readonly presentation?: CodingToolPresentation<Static<TParameters>, TDetails>;
}

interface CodingToolContext { readonly cwd: string; }

function toAgentTool<TParameters, TDetails>(
  definition: CodingToolDefinition<TParameters, TDetails>,
  context: CodingToolContext,
): AgentTool<TParameters, TDetails>;
```

内置定义由 `createDefaultToolDefinitions()` 创建：`bash`、`read_file`、`write_file`、
`edit_file`、`glob`、`todo_write`。Coding Agent 构造期把每个定义投影为 `AgentTool` 交给
Harness 的工具注册表，并把 `presentation` 注册进 presentation registry。

## 工具与 Todo 状态

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
`todo_write` 的 presentation（渲染 details 为逐行列表）在 `createTodoWriteToolDefinition().presentation`，
不在 UI 包。

## 运行时

```ts
interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}

interface CreateCodingAgentConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

function createCodingAgent(config: CreateCodingAgentConfig): Promise<CodingAgentRuntime>;
```

`session` 在类型上必填，运行时仍保留 `session is required` 守卫（JavaScript 调用方不会拿到属性崩溃）。

## 完整公开导出

从 `src/coding-agent/index.ts`：

- `createCodingAgent`、`createDefaultCodingHookRegistry`、`createDefaultToolDefinitions`、`toAgentTool`
- `CodingToolPresentationRegistry`、`NO_INTERACTIONS`、`CODING_SYSTEM_PROMPT`
- `CodingAgentRuntime`、`CreateCodingAgentConfig`、`CodingHookContext`
- `CodingAgentInteractions`、`ConfirmationRequest`、`Notification`
- `CodingToolDefinition`、`CodingToolContext`、`CodingToolPresentation`、`ToolPresentationCall`、`ToolPresentationRejected`
- `TodoItem`、`TodoDetails`

## 内部实现

以下名称仅供 coding-agent 内部使用，不作为稳定公共 API：

- `NO_INTERACTIONS` — 默认 fail-closed 交互实现
- `registerPermissionHook`
- `classifyBashCommand`、`hardDeniedBashReason`

## 依赖方向

```text
ui
    │ 实现 CodingAgentInteractions；只消费 CodingAgentRuntime + HarnessEvent
    ▼
coding-agent
    │ 创建默认 HookRegistry、Coding Tool 定义；向下投影 AgentTool/AgentHook
    ▼
harness
    │ 消费 AgentEvent，发布平坦 HarnessEvent
    ▼
agent
    │ 在控制点触发 Hook Call
    ▼
ai
```

源码依赖始终向下：`ui -> coding-agent -> harness -> agent -> ai`。运行时 `PermissionHook ->
injected CodingAgentInteractions` 是依赖倒置后的接口调用。
