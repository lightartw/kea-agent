# 事件、Hook 与 Coding Tool UI 设计

日期：2026-08-13

状态：已批准，待最终审阅

## 1. 目标

Kea 分为五层：

```text
ui -> coding-agent -> harness -> agent -> ai
```

本设计明确三件事：

1. Hook 与 Event 的行为契约；
2. Agent Hook、Harness Hook 和 Event 的所属层；
3. Coding Agent 如何组装 Tool、Hook 与 UI，而不让 UI 进入 Agent 或 Harness。

核心规则是：

> 行为由哪一层实现，对应的 Hook Call 和 Event 就由哪一层定义。

## 2. Hook 与 Event

Hook 和 Event 都会调用已注册代码，但权限不同。

### 2.1 Hook Call：询问决策

Hook Call 表示一个尚未提交的候选动作。Handler 可以按照该 Call 的契约阻止、转换或修补它。

```ts
const result = await hooks.trigger(call, signal);
```

每种 Hook Call 必须明确：

- 在什么决策点触发；
- Handler 可以返回什么；
- 多个结果如何聚合；
- Handler 抛错或被取消时如何处理。

Hook 必须由拥有该行为的代码显式触发。Registry 能让一个决策点拥有任意数量的 Handler，但不能替宿主创造一个不存在的决策点。

### 2.2 Event：公布事实

Event 表示已经确定、开始或提交的运行事实。

```ts
events.subscribe((event) => {
  // 返回值不影响运行
});
```

Event Listener：

- 不能阻止或修改执行；
- 不进入业务 reducer；
- 出错时与业务执行隔离；
- 可以用于 UI、日志和遥测。

Event 不必描述已经结束的动作。例如 `tool_start` 表示工具已经获准并开始执行，因此是事实，不再接受 Listener 否决。

### 2.3 为什么不能只保留 Hook

一次被拒绝的工具调用会经过：

```text
BeforeToolCall
  -> Hook 返回 block
  -> Agent 提交拒绝结果
  -> 发布 tool_rejected
```

`BeforeToolCall` 描述候选动作，`tool_rejected` 描述最终事实。UI、日志和恢复逻辑需要最终事实，不能从候选动作推断结果。

流式文本、持久化提交和 run 结束也没有对应的控制决策，因此不能通过 Hook 完整表达。Hook 负责控制，Event 负责观察，两者不能互相替代。

## 3. 分层所有权

| 层 | 拥有的概念 | 不应知道 |
| --- | --- | --- |
| `ai` | 模型消息、Tool schema、模型流事件 | Agent、Harness、UI |
| `agent` | Agent Loop、Agent Tool、Agent Hook、Agent Event | Harness、Coding Agent、UI |
| `harness` | run/session/lane、Harness Hook、Harness Event | Coding Agent、UI |
| `coding-agent` | Coding ToolDefinition、Coding Hook 实现、UI seam、组合工厂 | 具体 CLI/TUI 实现 |
| `ui` | CLI/TUI Adapter 与输出生命周期 | Agent/Harness 的内部装配 |

依赖关系是单向的。Coding Agent 是组合根，因此在构造阶段可以直接实现 Agent 的 Tool 与 Hook 接口；构造完成后的产品运行只通过 Harness。

## 4. Hook 模块

Hook 包含“通用注册机制”和“所属层的决策契约”。这两部分不能混为一个全局 Hook 类型。

### 4.1 Agent Hook

Agent Loop 的决策点由 `agent/hooks` 定义：

```ts
type AgentHookCall =
  | BeforeUserPromptCall
  | TransformContextCall
  | BeforeToolCall
  | AfterToolCall
  | BeforeStopCall;

type ResultOf<TCall> = /* 对应 Call 的结果 */;

class HookRegistry<TContext> {
  register<TType extends AgentHookCall["type"]>(type, handler): Unregister;
  trigger<TCall extends AgentHookCall>(
    call: TCall,
    signal?: AbortSignal,
  ): Promise<ResultOf<TCall> | undefined>;
}
```

Agent Loop 直接触发这些 Call。Harness 不把自己的 Hook 穿入 Agent Loop。

### 4.2 Harness Hook

Harness 将来实现 compaction、navigation、run acceptance 等决策时，在 `harness/hooks` 定义相应的 Call、Result 和 reducer，并由 Harness 自己触发。

```text
agent/hooks       控制 Agent Loop 的决策
harness/hooks     控制 Harness 的决策
```

两者使用相同设计规范，但不共享一个 Call 联合，因为它们属于不同层，也具有不同的聚合和错误语义。

### 4.3 通用 Registry 内核

Handler 存储、触发时快照、幂等注销和 cleanup 生命周期可以复用。当前只有 Agent Hook 使用这些能力，先保留现有实现。

第一个 Harness Hook 出现后，再把两边真正相同的实现提取到顶层 `hooks/registry-core.ts`。Call、Result、reducer 和错误策略仍留在所属层。这样共享机制，但不耦合业务类型。

## 5. Agent Event 与 Harness Event

`AgentEvent` 描述单次 Agent 执行中的 turn、模型流和工具执行：

```text
agent_start / agent_end
turn_start / turn_end
text_delta / thinking_delta
toolcall_start / toolcall_delta / toolcall_end
tool_start / tool_end / tool_rejected
```

`HarnessEvent` 描述 run、lane、session、compaction 和 navigation。Harness 向上转发 Agent 事实时增加运行上下文，但不复制 Agent Event：

```ts
type HarnessEvent =
  | HarnessOwnedEvent
  | {
      readonly type: "agent_event";
      readonly lane: string;
      readonly runId: string;
      readonly event: AgentEvent;
    };
```

使用 envelope 的理由：

- Agent 继续拥有自己的事实类型；
- Harness 可以补充 `lane` 和 `runId`；
- 上层只订阅一个 Harness 观察流；
- Agent 与 Harness 的同名概念不会被扁平联合混在一起。

Event 是否持久化由具体类型决定。`entry_added` 是提交后的 durable fact，流式 `text_delta` 是 transient fact。

## 6. CodingToolDefinition

`AgentTool` 只负责 Agent 所需的 schema、validation 和 execute。Coding Tool 还需要工作目录等 Coding 上下文，以及可选的展示策略，因此 Coding Agent 定义更完整的类型：

```ts
interface CodingToolDefinition<
  TParameters extends TObject,
  TDetails = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;

  execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
    context: CodingToolContext,
  ): Promise<AgentToolResult<TDetails>>;

  readonly presentation?: CodingToolPresentation<
    Static<TParameters>,
    TDetails
  >;
}
```

`CodingToolContext` 只放 Coding Tool 执行确实需要的稳定能力。第一版只需要 `cwd`；不放 UI、Harness、Session 或任意服务定位器。

### 6.1 向 Agent 投影

Coding Agent 使用一个 Adapter 将定义投影为 `AgentTool`：

```ts
function toAgentTool<
  TParameters extends TObject,
  TDetails,
>(
  definition: CodingToolDefinition<TParameters, TDetails>,
  context: CodingToolContext,
): AgentTool<TParameters, TDetails>;
```

Adapter 保留：

```text
name + description + parameters + execute
```

Adapter 不传递：

```text
presentation + Coding Agent UI 类型 + 前端类型
```

因此 Tool 作者可以在一个定义中声明执行和展示，Agent 仍然只能看到执行能力。

### 6.2 content 与 details

Tool result 中：

- `content` 是模型可见表示；
- `details` 是程序可见的结构化数据。

两者必须从同一份领域结果生成。若 `AfterToolCall` 修改 `details`，必须同时返回与其一致的 `content`，否则模型状态和 UI 状态会分叉。

## 7. Coding Agent 的两类 UI seam

Tool Presentation 和用户 Interaction 都属于 Coding Agent，但方向不同：

```text
Presentation：运行事实 -> 展示内容
Interaction：决策请求 -> 用户回答
```

### 7.1 Tool Presentation

```ts
type ToolPresentationOutput = string;

interface CodingToolPresentation<TArguments, TDetails> {
  renderStart(call: ToolPresentationCall<TArguments>): string | undefined;
  renderEnd(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): string | undefined;
  renderRejected?(
    event: ToolPresentationRejected<TArguments>,
  ): string | undefined;
}
```

`CodingToolPresentationRegistry` 按 tool name 保存 Presentation，并集中处理：

- typed details 的收窄；
- 专用 Presentation 查找；
- 缺失或返回 `undefined` 时的 fallback；
- Presentation 异常隔离。

Presentation 只解释已确定的工具事实，不能执行工具或改变结果。第一版返回 `string`；出现第二种真实前端后，再根据共同需求决定是否引入前端中立的展示模型。

### 7.2 CodingAgentInteractions

```ts
interface CodingAgentInteractions {
  readonly available: boolean;
  confirm(
    request: ConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}
```

这是前端提供给 Coding Agent 的双向能力。CLI、TUI、RPC 和无 UI 模式分别提供 Adapter。

Coding Hook 通过 Context 使用它：

```ts
interface CodingHookContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}
```

Permission Hook 调用 `interactions.confirm()`，再把用户回答转换成 `BeforeToolCallResult`。Agent Hook 类型和 Agent Loop 都不知道 UI。

Tool Presentation 与 Interactions 分开，是因为前者失败时应回退展示，后者的回答、取消或失败会影响当前决策。把它们合并会让一个接口同时承担渲染、输入和控制策略，并随 Tool 与 Hook 数量增长。

## 8. Factory 与运行接口

Coding Agent factory 按以下顺序装配：

1. 创建 `CodingToolDefinition[]`；
2. 将每个定义投影并注册到 `AgentToolRegistry`；
3. 将可选 Presentation 注册到 `CodingToolPresentationRegistry`；
4. 创建 `HookRegistry<CodingHookContext>`，注入 Interactions 并注册 permission Hook；
5. 用 Agent Tool 和 Agent Hook 创建 Agent 执行模块；
6. 用 Agent 执行模块创建 Harness；
7. 返回 Coding Agent 运行对象。

```ts
interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}
```

运行阶段，UI 只 import Coding Agent 接口：

- 通过 `runtime.harness` 发送输入、停止运行和订阅 `HarnessEvent`；
- 通过 `runtime.presentations` 渲染 envelope 中的工具事实；
- 不直接访问 Agent Loop、Tool Registry 或 Hook Registry。

## 9. 目标目录

```text
src/
  ai/

  agent/
    agent-loop.ts
    types.ts
    hooks/
    tools/

  harness/
    agent-harness.ts
    types.ts
    events/
    hooks/              # 出现真实 Harness Hook 时创建
    session/

  coding-agent/
    factory.ts
    runtime.ts
    hooks/
    tools/
      definition.ts
      wrapper.ts
    ui/
      interactions.ts
      tool-presentation.ts
      presentation-registry.ts

  ui/
    cli-frontend.ts
    cli-harness-renderer.ts
    cli-interactions.ts
```

Agent 与 Harness 是不同层，因此最终成为同级目录。目录迁移和对应实现一起完成，不保留仅用于转发的兼容目录。

## 10. 本次实现范围

本次实现：

- 保留现有 Agent Hook 行为，调整所有权和装配；
- Harness 增加自己的 Event 类型，并使用 `agent_event` envelope；
- 增加 `CodingToolDefinition` 和 `toAgentTool()`；
- 将 Tool Presentation 与 Registry 放入 Coding Agent；
- 将 `CodingHookUI` 收敛为 `CodingAgentInteractions`；
- Factory 返回包含 Harness 与 Presentation Registry 的运行对象；
- UI 只通过该运行对象驱动和展示。

以下能力等真实需求出现后再设计：

- Harness compaction/navigation Hook；
- 通用 `hooks/registry-core.ts`；
- 第三方 ExtensionHost；
- TUI/Web 展示模型；
- snapshot/watch 恢复协议。

## 11. 验收条件

1. Agent 可以脱离 Harness 运行并使用 Agent Hook。
2. Agent 不 import Harness；Harness 不 import Coding Agent；核心层不 import UI。
3. Agent Hook 与 Harness Hook 分别由行为所有者定义和触发。
4. Hook Handler 可以按契约影响决策；Event Listener 永远不能影响执行。
5. UI 只订阅 Harness 观察流；Agent Event 通过 envelope 向上提供。
6. 每个 Coding Tool 在一个 `CodingToolDefinition` 中声明执行和可选 Presentation。
7. `toAgentTool()` 的结果不包含 Presentation 或 UI 类型。
8. Presentation 失败只触发 fallback，不改变 Agent 或 Harness 状态。
9. Hook 只通过 `CodingAgentInteractions` 请求用户交互。
10. `content` 与 `details` 保持同源和一致。
