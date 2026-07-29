# Agent Loop Hooks 设计

日期：2026-07-29

状态：待审阅

范围：`agent` 与 `coding-agent`；不设计新的 Harness Hook 事件，不实现 ExtensionHost

## 1. 背景

Kea 当前已经把模型调用、Agent Loop、Harness 与 Coding Agent 分成不同层，但 Hook 仍存在几个结构性问题：

- Agent Loop 既有固定回调又有 Hook，形成两套控制机制；
- 当前 `HookRegistry` 需要外部配置 reducer，调用方必须理解事件结果如何合并；
- `tool_result` 的 Hook 返回值会被丢弃；
- Hook、`AgentEvent` 与 `subscribe` 都使用回调，职责容易混淆；
- Coding Agent 的权限确认需要 UI，却不能让底层包反向依赖 CLI；
- 现有 Harness Hook 设计承载了过多尚未需要的扩展能力。

本设计参考 Pi Agent 的 typed hooks 思路，但以 Kea 当前包边界和五个实际 Coding Agent Hook 为准。它不迁移 Pi 的完整 Extension 机制，也不为未来能力提前增加实体。

## 2. 目标

本次设计需要实现：

1. 用一套带类型结果的 Hook 完全替代 Agent Loop 的固定控制回调；
2. 明确 Hook 与 `AgentEvent` / `subscribe` 的不同职责；
3. 让 Agent Loop 只依赖最窄的 Hook 触发接口；
4. 在 Coding Agent 中提供五个默认 Hook：
   - 上下文提示；
   - Bash 权限判断；
   - 工具调用日志；
   - 大输出提醒；
   - 会话停止摘要；
5. 通过窄 UI 接口注入权限确认能力，不产生 `coding-agent -> cli` 的源码依赖；
6. 让 Factory 完成默认 Hook 的组装，上层只需提供 UI；
7. 补齐清理、取消、错误传播、快照与生命周期语义；
8. 更新各包 README，使公开接口、依赖方向和数据流清晰可查。

## 3. 非目标

本次不做：

- 不定义 Harness 专属 Hook 事件；
- 不把 `AgentEvent` 改造成 Hook；
- 不实现 Pi 风格的 ExtensionHost、扩展加载、命令或 Provider 注册；
- 不提供任意自定义 Hook 事件的公共扩展协议；
- 不让权限 Hook 绕过现有工作区路径限制；
- 不在 Context Hook 中永久修改会话历史；
- 不引入第二个 Harness Hook dispatcher；
- 不保留 Agent Loop 的 `transformContext`、`beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn` 等固定回调兼容层。

Extension 将来可以作为更上层的装载与组合机制，把扩展注册到 Hook、工具、命令等宿主能力中。Hook 是这类机制可以使用的基础设施，但两者不是同一抽象，本次也不需要同时实现。

## 4. 两条运行通道

### 4.1 `AgentEvent` 与 `subscribe`：观察通道

`AgentEvent` 描述已经发生或正在发生的运行事实，例如 Agent 开始、Turn 开始、工具开始、工具结束。Harness 的 `subscribe` 让 UI 或其他消费者接收这些事件。

观察者的返回值必须被忽略。它不能：

- 阻止工具执行；
- 改写模型上下文；
- 修改工具结果；
- 要求 Agent 继续运行。

因此，`subscribe` 属于数据/观察通道。

### 4.2 Hook：控制通道

Hook 在状态或动作提交前被调用，可以根据事件契约：

- 阻止用户输入或工具调用；
- 临时转换本次模型请求的上下文；
- 修改工具输入；
- 修补工具结果；
- 在 Agent 原本准备停止时要求继续一轮。

因此，Hook 属于控制通道。两者虽然都由回调实现，但权限、调用时机和返回值契约完全不同，必须并存而不能合并。

文档中应解释英文含义：`trigger` 是“触发 Hook”，`subscribe` 是“订阅运行事件”。公共 API 沿用项目已有的 `register`、`registerObserver`、`trigger`，不引入 `emit`、`on` 或 `observe` 的同义命名。

## 5. 分层与依赖

依赖方向为：

```text
CLI/TUI/RPC
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

源码依赖始终向下。运行时 `permissionHook -> injected UI` 是依赖倒置后的接口调用，不是底层源码反向导入上层实现。

Harness 不重新命名或包装整套 Hook 类型，也不建立自己的平行事件联合。它只持有 `AgentHookTrigger` 并传给 Agent Loop。这样相邻包只传一层必要接口，同时避免无意义的多级别名。

## 6. Agent Hook 类型模型

事件通过 phantom result type 把事件与其允许的结果绑定：

```ts
declare const HookResult: unique symbol;

export interface HookEvent<TType extends string, TResult = void> {
  readonly type: TType;
  readonly [HookResult]?: TResult;
}

export type ResultOf<TEvent> =
  TEvent extends HookEvent<string, infer TResult> ? TResult : void;
```

`HookResult` 只服务于 TypeScript 类型推导，不要求运行时事件携带该字段。

### 6.1 `user_prompt`

```ts
export interface UserPromptResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface UserPromptEvent
  extends HookEvent<"user_prompt", UserPromptResult> {
  readonly type: "user_prompt";
  readonly prompt: string;
}
```

在用户输入写入真实历史前触发。Handler 按注册顺序执行。只有返回 `{ block: true }` 才提前结束；`{ block: false }` 与 `undefined` 都继续。

### 6.2 `context`

```ts
export interface ContextResult {
  readonly messages?: AgentMessage[];
}

export interface ContextEvent
  extends HookEvent<"context", ContextResult> {
  readonly type: "context";
  readonly messages: AgentMessage[];
}
```

在每次模型请求前触发。Handler 顺序转换：后一个 Handler 看到前一个 Handler 产出的 `messages`。

转换结果只用于当前这一次 `convertToLlm` 与 AI 请求，不能覆盖 Harness 的真实消息历史或 Session。下一轮仍从真实历史重新构造上下文。

### 6.3 `tool_call`

```ts
export interface ToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface ToolCallEvent
  extends HookEvent<"tool_call", ToolCallResult> {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  input: Record<string, unknown>;
}
```

Observer 先运行，然后 Handler 按注册顺序运行。Handler 可以原地修改 `input`，后续 Handler 与工具执行都看到修改后的值。只有 `{ block: true }` 提前结束。

Hook 完成后，最终输入仍必须由 `ToolRegistry` 根据 TypeBox schema 校验。Hook 不代替工具输入校验，也不能绕过它。

### 6.4 `tool_result`

```ts
export interface ToolResultPatch {
  readonly content?: string;
  readonly isError?: boolean;
}

export interface ToolResultEvent
  extends HookEvent<"tool_result", ToolResultPatch> {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: string;
  readonly isError: boolean;
}
```

Handler 顺序修补结果：后一个 Handler 看到已经应用前一个 patch 的事件。

最终结果必须一致用于：

- `tool_end` AgentEvent；
- 写入真实历史的 tool message；
- 下一次模型请求。

这同时修复当前触发 `tool_result` 后丢弃返回值的问题。

### 6.5 `stop`

```ts
export interface StopResult {
  readonly continueWith?: AgentMessage;
}

export interface StopEvent
  extends HookEvent<"stop", StopResult> {
  readonly type: "stop";
  readonly messages: readonly AgentMessage[];
}
```

仅当 assistant 正常完成且没有工具调用、Agent Loop 即将自然结束时触发。第一个返回 `continueWith` 的 Handler 获胜；该消息被加入真实历史，然后开始下一轮。全部返回 `undefined` 时结束。

Abort 与 AI 错误不触发 `stop`。

### 6.6 事件联合

```ts
export type AgentHookEvent =
  | UserPromptEvent
  | ContextEvent
  | ToolCallEvent
  | ToolResultEvent
  | StopEvent;
```

不增加 `pre_turn` 与 `turn_end` Hook。它们只有观察意义，已经由 `AgentEvent` / `subscribe` 表达；重复增加会重新制造两套观察机制。

本次 Registry 的运行时只支持 `AgentHookEvent` 中的事件。`HookRegistry` 的事件泛型用于保留精确的事件/结果推导，不代表已经承诺任意字符串事件扩展协议；遇到联合之外的事件类型必须明确报错。将来如开放自定义事件，需要另行定义其结果组合协议。

## 7. `HookRegistry`

### 7.1 公共 API

```ts
export type Unregister = () => void;
export type Cleanup = () => void | Promise<void>;

export type HookHandler<TEvent, TContext> = (
  event: TEvent,
  context: TContext,
  signal?: AbortSignal,
) =>
  | ResultOf<TEvent>
  | void
  | Promise<ResultOf<TEvent> | void>;

export type HookObserver<TEvent, TContext> = (
  event: TEvent,
  context: TContext,
  signal?: AbortSignal,
) => void | Promise<void>;

export class HookRegistry<
  TEvent extends HookEvent<string, unknown>,
  TContext,
> {
  constructor(context: TContext);

  get context(): TContext;
  setContext(context: TContext): void;

  register<TType extends TEvent["type"]>(
    type: TType,
    handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
  ): Unregister;

  registerObserver(observer: HookObserver<TEvent, TContext>): Unregister;

  trigger<T extends TEvent>(
    event: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined>;

  addCleanup(cleanup: Cleanup): Unregister;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}
```

### 7.2 顺序与快照

- Handler 按注册顺序执行；
- Observer 在相应事件的所有 Handler 前执行；
- Observer 返回值被忽略，不能控制流程；
- 每次 `trigger` 开始时快照当前 context、Observer 列表和该事件 Handler 列表；
- 触发期间的注册、注销或 `setContext` 只影响下一次 `trigger`；
- `Unregister` 幂等，多次调用没有额外效果。

Context 是一个普通、稳定的对象，不是服务定位器。`setContext` 主要为将来 UI 或 Extension 宿主更新运行上下文保留能力。

### 7.3 事件结果合并

调用方不应配置 reducer，也不应理解不同事件的结果怎样合并。删除当前公开的 `ReduceStrategy` 和 constructor reducer map。组合逻辑由 `HookRegistry` 内部按事件类型执行：

| 事件 | 组合规则 |
| --- | --- |
| `user_prompt` | 顺序执行；第一个 `block: true` 获胜并提前结束 |
| `context` | 顺序应用 `messages`，后一个看到前一个结果 |
| `tool_call` | 顺序执行与共享可变 input；第一个 `block: true` 获胜 |
| `tool_result` | 顺序应用 patch，后一个看到前一个结果 |
| `stop` | 第一个 `continueWith` 获胜并提前结束 |

这不是一个可配置的通用 reducer 抽象，而是封闭事件联合的一部分行为定义。将来新增事件时，必须同时定义它的组合语义和测试。

### 7.4 生命周期

- `addCleanup` 注册资源清理函数；
- `clear` 先移除 Handler 与 Observer，再按注册逆序运行全部 Cleanup；
- 即使某个 Cleanup 失败，其余 Cleanup 仍继续执行；
- 一个错误原样抛出；多个错误以 `AggregateError` 抛出；
- `clear` 完成后 Registry 可继续使用；
- `dispose` 调用 `clear`，幂等，并把 Registry 永久标记为已销毁；
- `dispose` 后 `register`、`registerObserver`、`trigger`、`setContext`、`addCleanup` 都必须拒绝操作；
- 同步方法在已销毁状态下直接抛错，异步方法返回 rejected Promise。

### 7.5 错误与取消

Registry 不吞掉也不包装 Handler / Observer 错误，由调用点根据业务语义决定如何处理。

同一个 Agent run 的 `AbortSignal` 作为第三个参数传给 Observer 与 Handler。Registry 不假定 Handler 可被强制中断；Handler 自己负责监听或向下传递 signal。

## 8. Agent Loop 集成

Agent Loop 只依赖触发能力：

```ts
export interface AgentHookTrigger {
  trigger<TEvent extends AgentHookEvent>(
    event: TEvent,
    signal?: AbortSignal,
  ): Promise<ResultOf<TEvent> | undefined>;
}
```

`AgentLoopConfig` 保留模型、`convertToLlm` 等运行依赖，并增加 `hooks: AgentHookTrigger`。它不能看到注册、Context、Cleanup 或 UI。

完整调用链：

1. 产生 `agent_start`；
2. 触发 `user_prompt`：
   - 被阻止：产生 `agent_end`，不写入用户消息；
   - 允许：写入用户消息；
3. 每轮产生 `turn_start`；
4. 从真实历史复制消息，触发 `context`，仅把结果交给本次 `convertToLlm` 与 AI；
5. 流式接收模型输出，写入 assistant 消息，产生 `turn_end`；
6. 若 AI 错误或 Abort：产生 `agent_end`，不触发 `stop`；
7. 若没有工具调用：
   - 触发 `stop`；
   - 有 `continueWith`：写入消息并开始下一轮；
   - 没有：产生 `agent_end`；
8. 若存在工具调用，对每个调用：
   - 产生 `tool_start`；
   - 触发 `tool_call`；
   - 若被阻止，构造错误工具结果；否则交给 `ToolRegistry` 校验并执行；
   - 触发 `tool_result`，应用最终 patch；
   - 把最终工具结果写入真实历史；
   - 产生携带同一最终结果的 `tool_end`；
9. 开始下一轮。

Agent Loop 不再接受或翻译固定控制回调。

### 8.1 调用点错误策略

| 调用点 | Hook 异常处理 |
| --- | --- |
| `user_prompt` | 当前 prompt reject；Harness 必须恢复 idle；不写入用户消息 |
| `context` | 当前 prompt reject；Harness 必须恢复 idle |
| `tool_call` | fail closed：不执行工具，构造 Hook 异常错误结果 |
| `tool_result` | 把结果替换为 Hook 异常内容并令 `isError: true` |
| `stop` | 当前 prompt reject；已经完成的 assistant 消息保留 |

权限 Hook 自己捕获 UI confirm 异常并返回 block，因此它通常不会让 `tool_call` 触发器抛错。

## 9. Harness 集成

Harness 配置接受可选的：

```ts
hooks?: AgentHookTrigger;
```

未传入时使用一个空 Registry 或空 trigger。Harness 只把同一个触发器传给 Agent Loop：

- 不创建 Harness Hook 事件；
- 不建立第二个 dispatcher；
- 不把固定回调翻译成 Hook；
- 不承担 Coding UI 或权限策略；
- 不实现 ExtensionHost。

Harness 的 `AgentEvent` 与 `subscribe` 继续承担运行观察。

## 10. Coding Agent Hook Context 与 UI

```ts
export interface PermissionRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export interface HookNotification {
  readonly source:
    | "context_inject"
    | "tool_log"
    | "large_output"
    | "summary";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface CodingHookUI {
  readonly available: boolean;
  confirm(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  notify(
    notification: HookNotification,
  ): void | Promise<void>;
}

export interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}
```

`NO_UI` 是 coding-agent 内部实现：

- `available: false`；
- `confirm` 返回 `false`；
- `notify` 不做任何事。

它不作为稳定公共 API 导出。

CLI 实现 `CodingHookUI`：

- `confirm` 用现有 readline 提问，默认拒绝；
- 提问期间临时暂停 ESC raw-input listener；
- 支持 AbortSignal，取消时安全结束询问；
- 完成后恢复 listener；
- `notify` 只负责渲染文本，不包含权限策略。

## 11. 五个默认 Coding Agent Hook

目录：

```text
src/coding-agent/hooks/
  types.ts
  context-inject.ts
  permission.ts
  log.ts
  large-output.ts
  summary.ts
  factory.ts
  index.ts
```

### 11.1 Context Inject

注册 `user_prompt` Handler。当前只展示教学行为：

```text
[HOOK] UserPromptSubmit: working in <cwd>
```

它通过 `ui.notify` 提示当前工作目录，不修改 prompt 或消息历史，因为系统提示词已经包含 cwd。README 必须明确说明该名字来自教学示例，而当前实现并不重复注入上下文。

### 11.2 Permission

注册 `tool_call` Handler，只处理 Bash 风险策略。

决策分三类：

- `deny`：直接拒绝；
- `ask`：有 UI 时询问，无 UI、用户拒绝或 UI 异常时拒绝；
- `allow`：不返回结果，继续执行。

硬拒绝至少包括：

- `sudo`；
- `shutdown`、`reboot`；
- `mkfs`；
- `dd if=`；
- 重定向到 `/dev/`；
- 对根目录的递归强制删除。

需要询问至少包括：

- 普通 `rm`；
- 重定向到 `/etc/`；
- `chmod 777`；
- 其他明确危险但不必无条件拒绝的 Bash 规则。

工作区策略保持不变：

- 工作区外路径继续由现有 safe-path 工具不变量直接拒绝；
- 工作区内的 read/write/edit 默认直接允许；
- Permission Hook 不能授权绕过工作区限制。

### 11.3 Log

注册全局 Observer，但仅处理 `tool_call`：

```text
[HOOK] <toolName>(...)
```

Observer 在控制 Handler 前执行，因此即使工具随后被 Permission 阻止，这次尝试仍被记录。

### 11.4 Large Output

注册全局 Observer，但仅处理 `tool_result`。当原始 `content.length > 100_000` 时发送 warning。

它只提醒，不截断、不修补工具结果。阈值是严格大于 100,000；等于该值不提醒。

### 11.5 Summary

注册 `stop` Handler，统计当前真实消息中 `role === "tool"` 的数量并提示：

```text
[HOOK] Stop: session used N tool calls
```

返回 `undefined`，不要求 Agent 继续运行。

## 12. Bash 策略单一来源

新增 coding-agent 内部模块：

```text
src/coding-agent/tools/bash-policy.ts
```

接口：

```ts
export function hardDeniedBashReason(
  command: string,
): string | undefined;

export function classifyBashCommand(
  command: string,
):
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };
```

Permission Hook 使用 `classifyBashCommand`。`BashTool` 在真正调用 backend 前只重新执行 `hardDeniedBashReason`，作为不依赖 Hook 的纵深防御。

现有对所有 `"rm "` 的硬拒绝应移除：

- 默认 Factory 中的普通 `rm` 由 Permission Hook 询问；
- 单独使用 BashTool 时仍会无条件阻止根目录、sudo、设备写入等硬拒绝项。

策略解析应集中在该模块，不能在 Hook 和 BashTool 中各维护一份规则。

## 13. Factory 组装

Coding Agent 提供：

```ts
export function createCodingHookRegistry(
  context: CodingHookContext,
): HookRegistry<AgentHookEvent, CodingHookContext>;
```

它创建 Registry 并注册上述五个默认 Hook。

`CreateHarnessConfig` 增加：

```ts
ui?: CodingHookUI;
```

`createHarness` 使用 `project.workDir` 与 `ui ?? NO_UI` 创建每个 Harness 独立的 Registry，再作为窄 `AgentHookTrigger` 传入 Harness。不同 Harness 不能共享可变 Hook context 或注册表。

CLI 启动顺序调整为：

1. 创建 `CliFrontend`；
2. 调用 `createHarness({ ..., ui: cli })`；
3. 调用 `cli.run()`。

上层无需手工组装五个 Hook。

## 14. 公共接口

### 14.1 `agent` 包的 Hook 相关导出

- `HookRegistry`
- `AgentHookEvent`
- `AgentHookTrigger`
- `HookEvent`
- `HookHandler`
- `HookObserver`
- `ResultOf`
- `Unregister`
- `Cleanup`
- `UserPromptEvent`、`UserPromptResult`
- `ContextEvent`、`ContextResult`
- `ToolCallEvent`、`ToolCallResult`
- `ToolResultEvent`、`ToolResultPatch`
- `StopEvent`、`StopResult`

`HookResult` phantom symbol 不作为运行时公共值导出。`agent` README 还必须列出该包原有的全部公开接口；以上只是本功能涉及的 Hook 接口，不能被误写成整个包的唯一导出。

### 14.2 `coding-agent` 包的 Hook 相关导出

- `createHarness`
- `createCodingHookRegistry`
- `CodingHookContext`
- `CodingHookUI`
- `HookNotification`
- `PermissionRequest`

五个默认 Handler 与 `NO_UI` 保持内部实现，不承诺为稳定公共接口。

`coding-agent` README 同样必须列出该包的全部实际公开接口；本节只确定本功能新增或直接涉及的部分。

### 14.3 包边界

- `agent` 定义通用 Agent 控制事件与 Registry；
- `agent/harness` 使用窄 trigger，但不拥有新的 Hook 概念；
- `coding-agent` 定义 Coding 产品需要的 UI port、策略与默认 Hook 组合；
- CLI 只实现 UI port；
- `ai` 不知道 Agent Hook、Coding UI 或 Harness；
- Hook 类型不经过多层无意义别名透传。

## 15. 测试策略

### 15.1 Registry

必须覆盖：

- Handler 注册顺序；
- Observer 先于 Handler；
- 触发时 Handler / Observer 快照；
- 触发时 context 快照；
- 幂等注销；
- 五类事件的组合规则；
- Cleanup 逆序；
- 单个与多个 Cleanup 错误；
- `clear` 后可复用；
- `dispose` 幂等且禁止后续操作；
- Handler / Observer 错误原样传播；
- AbortSignal 原样传入。

### 15.2 Agent Loop

必须覆盖：

- Context 只影响当前模型请求，不修改真实历史；
- `tool_call` 只有 `block: true` 阻止；
- Hook 修改输入后仍进行最终 TypeBox 校验；
- `tool_result` 的最终结果同时影响事件、历史与下一次 LLM 请求；
- `stop.continueWith` 开启下一轮；
- AI 错误和 Abort 不触发 `stop`；
- 第 8.1 节定义的每个 Hook 异常路径。

### 15.3 五个默认 Hook

必须覆盖：

- cwd 通知；
- Permission 的 allow / ask / deny；
- 无 UI、用户拒绝、UI 异常均 fail closed；
- 不安装 Hook 时 BashTool 仍执行硬拒绝；
- Log 能看到之后被阻止的工具调用；
- Large Output 仅在长度严格大于 100,000 时提醒；
- Summary 正确统计 tool message；
- 每个 Harness 的 Context 与 Registry 相互隔离。

### 15.4 Factory 与 CLI

必须覆盖：

- Factory 默认完整组装五个 Hook；
- 无 UI 时需要询问的命令被拒绝；
- CLI confirm 默认拒绝；
- ESC / Abort 可取消 confirm，并恢复输入监听；
- notify 正确输出；
- 包之间不存在禁止的反向 import。

## 16. 文档更新

实现阶段同步更新：

- `src/agent/README.md`
  - 列出完整 Hook 公共 API；
  - 解释 `AgentEvent` / `subscribe` 与 Hook 的区别；
  - 说明五个控制点和结果语义。
- `src/agent/harness/README.md`
  - 说明 Harness 仅透传 Agent Hook；
  - 明确当前没有 Harness Hook 事件与 ExtensionHost。
- `src/coding-agent/README.md`
  - 说明默认五 Hook、UI port、Permission 策略、公共接口与依赖方向。
- `docs/architecture.md`
  - 更新运行调用链和包职责。
- 根 `README.md`
  - 删除或修正过时的 PermissionHook、AgentSession 与 LLM 描述。

README 的定位是让使用者迅速理解用法、总体概念、模块职责、完整导出与依赖边界；具体设计取舍保留在本规格中，不把 README 写成设计论文。

## 17. 验收标准

满足以下条件才算完成：

1. Agent Loop 不再存在四个固定控制回调；
2. 五种 Hook 的类型、顺序、结果与错误语义均有测试；
3. `tool_result` patch 不再被丢弃；
4. Harness 没有新增事件联合或第二个 Registry；
5. Coding Factory 默认组装五个 Hook；
6. Permission 无 UI时 fail closed，BashTool 独立保留硬拒绝；
7. CLI 通过接口注入，无反向源码依赖；
8. 所有生命周期与清理测试通过；
9. 各层 README 列出完整公共接口且与实际导出一致；
10. TypeScript 类型检查、现有测试与新增测试全部通过；
11. 实现不覆盖工作区中与本任务无关的已有修改。
