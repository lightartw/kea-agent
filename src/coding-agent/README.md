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
- 通过 `CodingHookUI` 注入权限确认能力，不产生 `coding-agent -> cli` 的源码依赖。
- CLI 实现 UI port；Coding Agent 永不导入 CLI 代码。

## 五个默认 Hook

| Hook | 类型 | 行为 |
|------|------|------|
| Context Inject | `user_prompt` Handler | 通过 `ui.notify` 提示当前工作目录；不修改 prompt 或历史 |
| Permission | `tool_call` Handler | Bash 命令的 allow/ask/deny 策略（见下文） |
| Log | Observer | 记录每个 `tool_call` 尝试；在 Permission 阻止前执行 |
| Large Output | Observer | `content.length > 100_000` 时发出 warning |
| Summary | `stop` Handler | 统计 tool message 数量并提示；不要求继续运行 |

Context Inject 的类名保留教学含义，但其当前实现只通知 cwd（系统提示词已包含 cwd，无需重复注入）。

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

## `CodingHookUI`

```ts
interface CodingHookUI {
  readonly available: boolean;
  confirm(request: PermissionRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}

interface PermissionRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

interface HookNotification {
  readonly source: "context_inject" | "tool_log" | "large_output" | "summary";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}
```

## `createCodingHookRegistry`

```ts
function createCodingHookRegistry(
  context: CodingHookContext,
): HookRegistry<AgentHookEvent, CodingHookContext>;
```

创建预配置了五个默认 Hook 的 Registry。可用于自定义组合场景。

## 完整公开导出

从 `src/coding-agent/index.ts`：

- `createHarness`、`createCodingHookRegistry`、`createToolRegistry`
- `CODING_SYSTEM_PROMPT`
- `CreateHarnessConfig`、`CodingHookContext`、`CodingHookUI`
- `HookNotification`、`PermissionRequest`

## 内部实现

以下名称仅供 coding-agent 内部使用，不作为稳定公共 API：

- `NO_UI` — 默认 fail-closed UI 实现
- `registerContextInjectHook`、`registerLogHook`、`registerLargeOutputHook`
- `registerPermissionHook`、`registerSummaryHook`
- `classifyBashCommand`、`hardDeniedBashReason`

## 依赖方向

```text
CLI/TUI
    │ 实现 CodingHookUI
    ▼
coding-agent
    │ 创建默认 HookRegistry，只向下传 AgentHookTrigger
    ▼
agent/harness
    │ 原样传递
    ▼
agent-loop
    │ 在控制点触发 Hook
    ▼
ai / tool registry
```

源码依赖始终向下。运行时 `PermissionHook -> injected UI` 是依赖倒置后的接口调用。
