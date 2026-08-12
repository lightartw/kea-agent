# Hook、Harness 与 Tool UI 边界设计

日期：2026-08-13

状态：已批准，待实现计划

范围：`ai`、`agent`、`agent/harness`、`coding-agent` 与当前行式 CLI UI。

本规格修订并覆盖 `2026-07-29-agent-loop-hooks-design.md` 中与以下内容有关的旧设计：

- `HookObserver` / `HookListener` / `registerListener()`；
- 把 log、large-output、summary 等被动展示实现成 Hook；
- `CodingHookUI` 只服务 permission 的窄类型；
- `tool_start` 在 `tool_call` Hook 之前发射；
- Tool result 没有 `details`，Todo 状态保存在工具实例；
- 具体 CLI 代码位于 `src/cli`。

旧规格中已实现且不与本文冲突的 Hook reducer、生命周期、权限策略和 AgentHarness 基础行为继续有效。

## 1. 目标

本次设计解决三类相近但不同的能力：

1. Hook 如何拦截和修改尚未确定的 Agent 动作；
2. Harness 如何把已经确定的运行事实交给 UI；
3. Tool 如何提供结构化数据，而不依赖具体 UI。

最终保持三条明确通道：

```text
Hook
  候选动作 -> 干预 -> 最终决定

Hook UI
  Hook -> confirm / notify -> 用户

Harness UI
  最终事实 -> subscribe -> renderer
                     \-> tool renderer
```

其中 Tool UI 是 Harness UI 内部针对工具事件的专用渲染分支，不是第四套运行机制。

## 2. 非目标

本次不做：

- 不实现 Pi Coding Agent 的 ExtensionHost；
- 不复制 Pi 新 Harness 尚未实装的完整 durable lane、watch 和 recovery 体系；
- 不设计 TUI Widget、RPC 协议或第二个真实前端；
- 不给 `AgentTool` 增加 CLI/TUI renderer；
- 不为每个 Hook 增加一个独立的 interaction 方法；
- 不把 Hook、Event 和 UI 合并为一个通用事件总线；
- 不增加 select、input、custom component、status bar 等当前没有需求的 UI 原语；
- 不在本次顺带完成多模态 Tool result、tool usage、dynamic tools 或 terminate。

## 3. Kea Hook 的定位及 Pi 对应关系

Kea 当前 Hook 是 **Agent Loop 层的可注册拦截机制**。它在两个方面分别借鉴 Pi：

- 执行位置对应 Pi 旧 `agent-loop` 的固定回调；
- Registry、顺序聚合和多 Handler 形式对应 Pi 新 Harness 的 Hook 设计。

| Kea Hook | Learn Claude Code | Pi 旧 Agent Loop | Pi 新 Harness |
| --- | --- | --- | --- |
| `user_prompt` | `UserPromptSubmit` | 无完整对应项 | `before_run` 的一部分 |
| `context` | 无直接对应 | `transformContext` | `transform_context` |
| `tool_call` | `PreToolUse` | `beforeToolCall` | `before_tool` |
| `tool_result` | `PostToolUse` | `afterToolCall` | `after_tool` |
| `stop` | `Stop` | `shouldStopAfterTurn` / `prepareNextTurn` | `before_run_end` |

Kea 没有声称当前 Agent Hook 就是完整 Harness Hook。未来 Harness 增加 compaction、navigation、retry 等操作时，可以在 Harness 层增加对应拦截点；不能因此让当前 Agent Hook 提前承担尚不存在的 Harness 职责。

## 4. Hook、Event 与 subscribe

### 4.1 Hook 是控制通道

Hook 接收尚未确定的候选动作，可以按契约：

- 阻止用户输入或工具调用；
- 转换本次模型请求上下文；
- 修改工具参数；
- 修补工具结果；
- 在 Agent 原本准备停止时要求继续。

多个 Handler 按注册顺序执行，后一个 Handler 看到前一个 Handler 已应用的结果。

### 4.2 Event 是观察数据

Event 描述已经开始或已经确定的运行事实。观察者不能通过返回值：

- 阻止工具执行；
- 修改模型上下文；
- 改写工具结果；
- 要求 Agent 继续运行。

### 4.3 subscribe 是 Harness 的 Event 交付方法

`AgentEvent` 和 `Harness.subscribe()` 不是两套观察机制：

- `AgentEvent` 是 Agent 层产生的数据；
- `subscribe()` 是 Harness 层向外交付数据的方法。

当前 Harness 主要转发 AgentEvent。未来 Harness 可以在保持语义的前提下添加 run、session、lane 等 Harness 上下文。

全局不变量：

> Hook 只处理尚未确定的候选动作；Event 只描述已经确定的事实；Harness.subscribe 是运行事实的外部观察入口。

## 5. Hook 类型与 Registry

### 5.1 术语

项目统一使用 `Call`，不引入 `Invocation`。Hook 输入类型采用：

```ts
BeforeUserPromptCall
TransformContextCall
BeforeToolCall
AfterToolCall
BeforeStopCall
```

现有领域术语继续保留：

```ts
AgentToolCall
toolcall_start
toolcall_delta
toolcall_end
tool_call
```

Hook 输入是调用过程中的候选值，因此不再命名为 `ToolCallEvent` 或 `ToolResultEvent`，避免和事实 Event 混淆。

### 5.2 Registry API

保留：

```ts
class HookRegistry<TContext> {
  register(type, handler): Unregister;
  trigger(call, signal?): Promise<Result | undefined>;
  addCleanup(cleanup): Unregister;
  clear(): Promise<void>;
  dispose(): Promise<void>;
}
```

删除：

```ts
HookListener
HookObserver
registerListener()
registerObserver()
```

原因是只观察而不改变执行的 Handler 与 Harness subscribe 重复。日志、统计、遥测和 UI 展示都应消费最终 Event。

`HookRegistry<TContext>` 继续保留 Context，因为未来多个 Coding Hook 可能共享稳定的运行环境能力；Context 必须保持窄且不能演变成任意服务定位器。

## 6. Coding Hook UI

### 6.1 为什么保留通用 Hook UI

不能因为当前只有 permission 需要交互，就把长期扩展边界压缩成 permission 专用回调。将来即使出现很多 Hook，它们通常仍然复用少数通用 UI 原语。

同时不能为每个 Hook 在 `CodingAgentInteractions` 中增加一个方法；Hook 数量增长时，该接口会线性膨胀。

因此采用一个通用但严格受限的 UI port：

```ts
export interface CodingHookUI {
  readonly available: boolean;

  confirm(
    confirmation: HookConfirmation,
    signal?: AbortSignal,
  ): Promise<boolean>;

  notify(
    notification: HookNotification,
  ): void | Promise<void>;
}

export interface HookConfirmation {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

export interface HookNotification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}
```

`source` 是稳定的来源标识，不建立封闭的 Hook 名称联合，避免每增加一个 Hook 都修改基础 UI 类型。

### 6.2 所有权与依赖

接口由 Coding Agent Hook 定义：

```text
src/coding-agent/hooks/types.ts
```

具体 CLI 实现位于：

```text
src/ui/frontend.ts
```

依赖方向：

```text
ui -> coding-agent -> agent -> ai
```

运行时 `Hook -> injected CodingHookUI` 是依赖倒置后的接口调用，不是源码反向依赖。

`CodingHookContext` 保存：

```ts
interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}
```

没有 UI 时使用 Coding Agent 内部的 `NO_HOOK_UI`：

- `available: false`；
- `confirm()` 返回 `false`；
- `notify()` 不执行任何操作。

需要确认但没有 UI 时必须 fail closed。

### 6.3 notify 的边界

`notify()` 只用于 Hook 自己产生、没有对应运行 Event 的即时说明，例如：

- 安全策略要求额外确认；
- 某个 Hook 的外部上下文来源不可用；
- Hook 采用了降级路径，需要立即提醒用户。

`notify()` 不得用于：

- 展示普通工具开始或结束；
- 输出工具结果；
- 统计会话工具数量；
- 实现通用日志、审计或遥测。

这些被动展示全部使用 Harness subscribe。

## 7. 现有五个 Coding Hook 的重新分类

| 当前模块 | 当前实际行为 | 目标 |
| --- | --- | --- |
| permission | 阻止或允许 Bash | 保留为 Hook，使用 `ui.confirm()` |
| context-inject | 只显示 cwd，没有注入上下文 | 删除；未来真有注入行为时再实现 Hook |
| log | 显示工具调用 | 从 Hook 删除，迁移为 subscribe renderer |
| large-output | 显示大结果提醒 | 从 Hook 删除，迁移为 `tool_end` observer |
| summary | 统计并显示工具数量 | 从 Hook 删除，迁移为 `agent_end` observer |

因此默认 Hook Factory 当前只注册真正改变控制流或数据的 Hook。被动功能由 UI 针对 Harness Event 组装。

## 8. Tool result 数据模型

采用 Pi 的分层：`AgentToolResult` 表示执行结果，`ToolResultMessage` 表示写入会话的完整消息。

### 8.1 ai 层

```ts
export interface ToolResultMessage<TDetails = unknown> {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly details?: TDetails;
  readonly isError?: boolean;
}
```

`details` 属于跨 Provider 的标准内部消息，但 Provider Adapter 不把它发送给模型。Adapter 只投影对应 Provider 需要的字段。

```text
content -> Provider payload
details -> Session / UI
```

### 8.2 agent 层

```ts
export interface AgentToolResult<TDetails = unknown> {
  readonly content: string;
  readonly details?: TDetails;
  readonly isError: boolean;
}
```

`AgentTool` 增加 details 泛型：

```ts
abstract class AgentTool<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> {
  abstract execute(...): Promise<AgentToolResult<TDetails>>;
}
```

异构 Registry、Hook 和 Event 边界将 details 看作 `unknown`；具体 Tool 内部保留精确类型。

### 8.3 最终结果一致性

`AfterToolCall` 和对应 patch 增加 `details?: unknown`。Agent Loop 必须保证同一个 Hook 处理后的最终结果用于：

- 写入 Session 的 `ToolResultMessage`；
- `tool_end` Event；
- 下一次模型请求；
- UI renderer。

Hook 没有返回某个字段时保留原值，不做深合并。

`AgentMessage` 当前继续等于 ai `Message`。`details` 不需要新增 `AgentToolResultMessage`。未来真正增加新的消息 role 时，再采用 Pi 的 `CustomAgentMessages` declaration merging 模式扩展 AgentMessage。

## 9. 工具调用时序

### 9.1 成功执行

```text
模型产生 AgentToolCall
  -> BeforeToolCall Hook
  -> 参数确定并通过验证
  -> tool_start Event
  -> AgentTool.execute()
  -> AfterToolCall Hook
  -> 最终 ToolResultMessage
  -> 写入 Session
  -> tool_end Event
```

`tool_start` 必须携带 Hook 处理后的有效参数，只能表示真实执行已经开始。

### 9.2 被 Hook 阻止、参数无效或工具不存在

这些路径没有真实 Tool effect，因此不产生 `tool_start`：

```text
候选调用
  -> clearance 失败
  -> synthetic error ToolResultMessage
  -> 写入 Session
  -> tool_rejected Event
```

```ts
type ToolRejectedReason =
  | "blocked"
  | "invalid"
  | "unknown"
  | "aborted";

interface ToolRejectedEvent {
  readonly type: "tool_rejected";
  readonly call: AgentToolCall;
  readonly result: AgentToolResult<unknown>;
  readonly reason: ToolRejectedReason;
}
```

这避免没有 `tool_start` 却收到 `tool_end` 的不完整生命周期，也避免把“准备尝试”误称为“开始执行”。

### 9.3 当前代码修正

当前 `agent-loop.ts` 在 `tool_call` Hook 之前 yield `tool_start`，属于错误语义，必须调整。Event 公开的一律是 Hook 处理后的最终值。

## 10. Harness UI

不设计一个 `HarnessUI` 反向接口。UI 通过 subscribe 消费运行事实：

```ts
const unsubscribe = harness.subscribe((event) => {
  frontend.render(event);
});
```

调用链：

```text
Agent Loop
  -> AgentEvent
  -> Harness 持久化/协调
  -> Harness.subscribe
  -> CliFrontend
  -> Harness renderer
```

约束：

- UI 不绕过 Harness 直接绑定 Agent Loop；
- renderer 返回值不能改变执行；
- 具体 UI renderer 自己隔离渲染错误；
- 本次不重写通用 Harness event bus 的错误报告协议；Pi 的 `handler_error` 可作为未来 Harness 重构参考。

## 11. Tool UI

### 11.1 Renderer Registry

Tool 不依赖 UI，也不携带 renderer。UI 层按工具名注册：

```ts
interface CliToolRenderer {
  renderStart(call: AgentToolCall): string | undefined;

  renderEnd(
    call: AgentToolCall,
    result: AgentToolResult<unknown>,
  ): string | undefined;
}
```

```ts
toolRenderers.register("bash", bashRenderer);
toolRenderers.register("todo_write", todoRenderer);
```

行为：

1. 有专用 renderer 时使用专用展示；
2. 没有专用 renderer 时使用通用 fallback；
3. details 无效时回退到 content；
4. renderer 抛错时记录 UI 错误并使用 fallback；
5. renderer 错误绝不影响 Agent 执行。

当前 CLI 只实现文本渲染。未来 TUI 或 RPC 共享 Event、Session 和 details，不共享具体渲染对象。

### 11.2 与 Pi Tool renderer 的区别

Pi Coding Agent 为 Extension 开发体验，把 `execute`、`renderCall` 和 `renderResult` 声明在同一个 `ToolDefinition`，进入 Agent core 时再剥离 renderer。

Kea 当前没有 ExtensionHost，因此直接把 renderer 注册在 UI 层：

- AgentTool 保持 UI-free；
- 不引入 TUI component 类型；
- 将来实现 Extension 时，可以新增“一处声明、工厂拆分”的便利层，无需改变 Agent 边界。

## 12. TodoWrite

TodoWrite 改为无状态 Tool。删除工具实例中的：

```ts
private todos: readonly TodoItem[];
```

定义结构化结果：

```ts
export interface TodoDetails {
  readonly todos: readonly TodoItem[];
}
```

每次调用接收完整列表并返回：

```ts
{
  content: "Updated 3 tasks",
  details: { todos: arguments_.todos },
  isError: false,
}
```

Todo 的真实状态定义为：

> 当前 Session 分支中最后一条有效 `todo_write` ToolResultMessage 的 `details.todos`。

UI 使用纯函数投影：

```ts
function findLatestTodoDetails(
  messages: readonly AgentMessage[],
): TodoDetails | undefined;
```

不增加新的 Todo 状态容器或 `TodoProjection` 类。这样重启、恢复和未来分支切换都会自然得到正确状态。

当前行式 CLI 只实现 transcript 展示；未来常驻 TUI Widget 使用同一份 details，不修改 Tool、Agent 或 Session。

## 13. UI 文件组织

具体 UI 实现统一放入 `src/ui`，原 `src/cli` 移除：

```text
src/ui/
  frontend.ts          # CliFrontend、输入循环、CodingHookUI 实现、统一协调
  harness-renderer.ts  # 通用 Harness/Agent Event 展示
  tool-renderers.ts    # Tool renderer 接口、Registry、fallback
  todo-renderer.ts     # Todo 专用 renderer 与历史投影
```

不提前增加 `ui/cli`、`ui/tui` 等子目录；只有一个真实前端时保持结构紧凑，出现第二个前端后再提取共享层。

领域接口仍留在拥有它的包：

```text
src/coding-agent/hooks/types.ts
  CodingHookUI
  HookConfirmation
  HookNotification
  CodingHookContext

src/coding-agent/tools/todo-write.ts
  TodoItem
  TodoDetails

src/ai/types.ts
  ToolResultMessage<TDetails>

src/agent/tools/types.ts
  AgentToolResult<TDetails>
```

“UI 实现集中”不等于把需求方定义的 port 或领域数据错误地移动到 UI 包。

## 14. Factory 组装

```text
main
  -> 创建 CliFrontend
  -> createHarness({ ui: frontend })
  -> frontend.run(harness)
```

Coding Agent Factory：

- 使用 `project.workDir` 和 `ui ?? NO_HOOK_UI` 创建 CodingHookContext；
- 创建每个 Harness 独立的 HookRegistry；
- 只注册真正的控制 Hook；
- 创建默认 Tool Registry；
- 把窄 `AgentHookTrigger` 交给 AgentHarness。

CliFrontend：

- 实现 `CodingHookUI.confirm/notify`；
- 使用 `harness.subscribe()` 处理被动展示；
- 把工具事件分发给 Tool renderer registry；
- 管理 readline、ESC 和 abort 的输入互斥。

## 15. 与 Pi Agent 的总体对比

| 设计点 | Pi | Kea |
| --- | --- | --- |
| 低层 Agent Hook | 旧 loop 使用固定 callback | 多 Handler HookRegistry |
| 新 Harness Hook | 设计较完整，仍在逐步实装 | 当前 Agent Hook 不冒充完整 Harness Hook |
| Hook passive listener | 新 Harness 无此设计 | 删除 |
| Hook UI | 新 Harness 无；旧 Extension 有宽 UI Context | Coding Agent 提供窄 `confirm + notify` |
| Event 观察 | AgentEvent 与新 Harness Events/watch | AgentEvent 经 Harness subscribe |
| ToolResult details | ai ToolResultMessage 基础字段 | 采用相同设计 |
| AgentToolResult | Tool 执行结果 | 采用相同分层 |
| Tool renderer | Extension ToolDefinition 声明，进入 core 时剥离 | UI registry 按工具名注册 |
| Todo 状态 | 从 Session tool-result details 重建 | 采用相同设计 |
| 多前端 | TUI、RPC、print adapters | 当前只有 CLI，边界允许扩展 |

Pi 是重要设计参考，但不是无需判断的规范：

- 旧 Extension UI 的宽接口服务第三方扩展平台，Kea 当前不复制；
- 新 Harness 对 Hook/Event 的严格分离值得采用；
- 新 Harness 尚未全部实装的部分只用于验证方向，不作为 Kea 当前行为的唯一依据。

## 16. 错误与降级

### Hook UI

- `available === false` 时，必须确认的 Hook fail closed；
- confirm 返回 false 时正常拒绝，不作为异常；
- confirm 抛错或被 Abort 时，permission Hook 返回拒绝结果；
- notify 抛错不得改变相应 Hook 的控制结果，Hook 应采用安全降级。

### Tool details 与 renderer

- Session 读取时允许 ToolResultMessage 携带 JSON-safe details；
- Todo renderer 在使用前验证 details 结构；
- 旧 Session 没有 details 时使用通用 content；
- renderer 错误局限在 UI，并回退到 fallback。

### Agent Loop

- BeforeToolCall 抛错按 fail closed 处理；
- AfterToolCall 抛错产生最终 error result；
- synthetic result 与正常 result 都必须写入 Session；
- 只有真实 Tool effect 产生 `tool_start` / `tool_end`。

## 17. 测试设计

### 17.1 Hook Registry

- 多 Handler 注册和聚合顺序；
- 删除 listener/observer API 后的公共导出检查；
- Call 类型名称不出现 `Invocation`；
- Context 快照、注销、cleanup、dispose 和 AbortSignal 现有行为继续通过。

### 17.2 Agent Loop

- Hook 允许后才产生 `tool_start`；
- Hook 修改后的参数出现在 Tool 与 `tool_start`；
- blocked、invalid、unknown、aborted 分别产生正确 `tool_rejected`；
- 真实 Tool 执行产生匹配的 `tool_start` / `tool_end`；
- details 经过 AfterToolCall patch 后一致进入 Event、历史和下一次请求；
- ToolResultMessage details 不被 Provider Adapter 发送。

### 17.3 Session

- ToolResultMessage details 可以 JSONL round-trip；
- 缺少 details 的旧消息仍可打开；
- 无效非 JSON 数据被存储边界拒绝；
- 从当前分支能找到最后一个有效 TodoDetails。

### 17.4 Coding Agent Hook

- Permission allow / ask / deny；
- 无 UI、用户拒绝、Abort 和 UI 异常均 fail closed；
- HookConfirmation 使用通用 source/title/message；
- 默认 Factory 不再注册 context-inject、log、large-output、summary 假 Hook；
- notify 仅测试 Hook 专属说明，不用于运行 Event 展示。

### 17.5 UI

- Harness renderer 处理普通生命周期事件；
- Tool renderer 专用匹配和通用 fallback；
- large-output 警告消费最终 `tool_end`；
- summary 消费最终 `agent_end`；
- TodoDetails 正确渲染；
- 缺失/错误 details 和 renderer 异常都回退；
- CLI confirm 的默认拒绝、ESC/Abort 和输入 listener 恢复；
- `src/ui` 不被 agent、harness 或 coding-agent 反向导入。

## 18. 文档更新

实现时同步更新：

- `src/ai/README.md`：完整说明 ToolResultMessage details 及 Provider 投影；
- `src/agent/README.md`：Hook Call、AgentEvent、Tool result 和完整公开接口；
- `src/agent/harness/README.md`：subscribe 的观察职责，以及当前 Agent Hook 的透传边界；
- `src/coding-agent/README.md`：CodingHookUI、默认 Hook、工具 details 和 Factory；
- 根 README：更新包依赖、启动用法和 UI 目录。

README 说明使用方式、总体概念、完整导出和依赖边界；本文保留详细设计理由。

## 19. 验收标准

1. Hook Registry 不再提供 passive listener/observer；
2. 所有 Hook 输入类型使用 `Call`，不使用 `Invocation`；
3. 被动展示只通过 Harness subscribe；
4. CodingHookUI 只提供 `confirm`、`notify` 和 availability；
5. Hook UI 不随 Hook 数量增加专用方法；
6. `details` 位于 ai ToolResultMessage，并贯穿 AgentToolResult、Session 与 UI；
7. Provider payload 不包含 details；
8. `tool_start` 只在 Hook 通过、参数有效并准备真实执行后产生；
9. 未执行的 Tool call 产生明确的 `tool_rejected`；
10. TodoWrite 无实例状态，可以从 Session 当前分支恢复；
11. Tool 不依赖 renderer 或 UI；
12. 所有具体 CLI UI 实现集中在 `src/ui`；
13. renderer 错误不影响 Agent 执行；
14. README 与实际公开导出、依赖方向一致；
15. 类型检查、现有测试和新增测试全部通过。
