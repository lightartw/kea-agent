# 事件机制、Hook 所有权与分层设计

日期：2026-08-13

状态：设计已批准，待文档审阅

范围：`ai`、`agent`、未来独立的 `harness`、`coding-agent` 与 `ui`，以及 Coding Agent 的 ToolDefinition、Tool Presentation 和 Hook Interaction Adapter。

本文进一步澄清 `2026-08-13-hook-harness-tool-ui-design.md` 中尚未完全解决的三个问题：

- Hook Call、Agent Event 与未来 Harness Event 是否应统一；
- Agent 与 Harness 都需要 Hook 时，Hook 模块应当放在哪里；
- Coding Agent 是否只能依赖 Harness，以及 Tool、Hook 如何参与装配；
- Tool UI 与 Hook UI 为什么需要不同的接口，以及如何在 Coding Agent 层统一收口。

本文只定义目标架构，不在本轮修改运行代码。

## 1. 核心结论

Kea 保留两种语义原语，不把它们合并成一个通用 Event：

1. **Hook Call 是决策请求**：动作尚未提交，Handler 的返回值可以改变控制流。
2. **Event 是运行事实**：事实已经确定，Listener 的返回值不能改变执行。

`subscribe()`、`on()`、`publish()`、`trigger()` 是交付方法，不是新的领域概念。

Hook 与 Event 可以复用类似的 Handler 存储、注册快照和清理实现，但公开契约必须分开。统一的是机制规范，不是 payload 联合类型。

## 2. 精确术语

### 2.1 Hook Call

Hook Call 表示系统抵达一个明确决策点，向已注册策略询问下一步行为。

它具有以下不变量：

- 发生在动作提交之前，或者发生在结果提交之前；
- Handler 按注册顺序执行；
- Handler 可以按该 Call 的契约阻止、替换、变换或修补；
- 每种 Call 都必须定义自己的 Result、聚合规则和错误策略；
- `trigger()` 必须被行为所有者显式调用并等待。

例子：`BeforeToolCall` 不是“工具已经执行”的事实，而是 Agent 在询问“这个候选工具调用是否以及如何执行”。

### 2.2 Event

Event 表示已经确定、已经开始或已经提交的运行事实。

它具有以下不变量：

- Listener 的返回值永远不能改变执行；
- Event 可以是瞬时事实，也可以是 durable fact；
- Listener 错误不能倒流为业务控制结果；
- Event 类型由产生事实的层拥有；
- 新增所属层能力时，可以新增该层 Event；“事实类型由所属层维护”不等于 Event 永不扩展。

`tool_start` 可以在工具尚未完成时发布，因为“工具已经获准并开始执行”已经是不可撤销的事实。

### 2.3 Interaction

`confirm()`、`notify()` 等是 Coding Agent 向具体前端提出的交互请求。它们既不是 Hook，也不是 Event：

- Hook 可以调用 `confirm()` 获取用户决策；
- Event renderer 可以调用 `notify()` 展示异常；
- Interaction 的接口由 `coding-agent` 定义，由 `ui` Adapter 实现。

Tool Presentation 同样是 UI seam，但与 Interaction 的方向不同：

```text
Presentation：已经有运行事实，决定如何显示。
Interaction：尚未作出决定，等待用户回答。
```

Presentation 通常是同步、无副作用的投影，失败时回退到通用展示，不能改变执行。Interaction 通常是异步双向调用，取消、超时或用户回答可以影响调用它的 Hook 决策。两者不得合并成一个不断膨胀的通用 UI 接口。

## 3. 为什么 Hook 不能替代 Event subscribe

Hook Handler 技术上可以顺便观察候选操作，但不能成为系统的权威事实流：

1. Hook 只覆盖决策点，不能自然表达 `text_delta`、durable commit、run end 等事实；
2. Hook 位于控制路径，必须等待；高频 UI 渲染不应进入控制路径；
3. Hook 的错误策略可能阻断或修改执行，UI renderer 错误则必须与执行隔离；
4. 候选操作不等于最终结果，重试、拒绝、失败和提交后的事实不能从 before Hook 可靠推断。

因此：

```text
Hook Call = 决策请求
Event     = 权威事实
subscribe = Event 的交付方法
```

## 4. Hook 的机制与语义所有权

“Hook 是独立模块”需要拆成两层理解。

### 4.1 当前保留 Agent Hook 实现

当前 `src/agent/hooks/` 的核心设计正确，继续保留：

```ts
type AgentHookCall =
  | BeforeUserPromptCall
  | TransformContextCall
  | BeforeToolCall
  | AfterToolCall
  | BeforeStopCall;

type ResultOf<TCall> = /* Call 到 Result 的类型映射 */;

class HookRegistry<TContext> {
  register<TType extends AgentHookCall["type"]>(type, handler): Unregister;
  trigger<TCall extends AgentHookCall>(
    call: TCall,
    signal?: AbortSignal,
  ): Promise<ResultOf<TCall> | undefined>;
}
```

不改成中央 `AgentHookMap`，也不恢复五个固定 callback 字段。

Registry 提供的可扩展性是：每个已定义决策点可以注册任意数量的 Handler，并共享一致的生命周期。它不能让外部扩展凭空发明一个宿主从未触发的新决策点。

增加新的 Agent Hook 必须：

1. 定义 Call 与 Result；
2. 将 Call 加入 Agent 层类型关系；
3. 定义 reducer 与错误策略；
4. 在拥有该决策的 Agent 代码中增加显式 `trigger()`。

这是决策语义本身的必要修改，不是固定 callback 设计。

### 4.2 未来 Harness 拥有自己的 Hook 契约

未来 Harness 实现 compaction、navigation、run acceptance 等能力时，由 Harness 定义和触发：

```text
harness/hooks/
  types.ts       BeforeRunCall、BeforeCompactionCall、BeforeNavigationCall 等
  registry.ts    Harness Call 对应的 reducer
  index.ts
```

Harness Hook 不加入 `AgentHookCall`，也不传入 Agent Loop。Agent 不知道 Harness Hook，Harness 也不能要求 Agent Loop 代为触发 Harness 决策。

### 4.3 何时抽取通用 Hook 内核

Agent 与 Harness 可以共享以下实现机制：

- Handler 注册和幂等注销；
- 触发时快照 Handler；
- Context 快照；
- cleanup、clear 与 dispose 生命周期。

但是目前只有 Agent Hook 一个真实使用者。现在创建顶层通用模块很可能只是浅层转发。

当第一个 Harness Hook 实现后，再通过删除测试判断是否值得提取：如果删除公共内核会让相同复杂性重新出现在 Agent 和 Harness 两处，则抽取：

```text
hooks/
  registry-core.ts

agent/hooks/
  types.ts
  registry.ts

harness/hooks/
  types.ts
  registry.ts
```

公共内核只拥有通用机制；Call、Result、reducer 和错误策略仍由各自层拥有。不创建全局 `HookCall` 联合。

## 5. 五层所有权

### 5.1 AI

AI 层拥有 provider-neutral 的模型传输协议：

```ts
type AssistantMessageEvent =
  | TextDelta
  | ThinkingDelta
  | ToolCallStart
  | ToolCallDelta
  | ToolCallEnd
  | Done
  | Error;
```

这些是 AI 流协议事实，不包含 Agent、Harness、Coding Agent 或 UI 语义。

### 5.2 Agent

Agent 层拥有：

- Agent Loop；
- `AgentTool` 与 `AgentToolRegistry`；
- `AgentHookCall`、`ResultOf` 与 Agent Hook reducer；
- `AgentEvent`。

Agent Hook 只控制 Agent 决策。`AgentEvent` 只描述 Agent 运行事实。

工具生命周期统一使用：

```text
tool_start
tool_update      仅在真正支持流式工具更新时增加
tool_end
tool_rejected
```

模型生成工具调用参数的 AI/Agent 流阶段继续使用：

```text
toolcall_start
toolcall_delta
toolcall_end
```

不同时增加语义重复的 `tool_execution_*`。

### 5.3 Harness

Harness 是 Agent 的上层运行模块，拥有：

- run、lane、queue、session 与 durable state；
- compaction、navigation、recovery 等 Harness 行为；
- Harness Hook；
- `HarnessEvent`。

Agent Event 与 Harness Event 不扁平合并。Harness 在需要向外提供完整运行观察流时，使用明确 envelope：

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

这样：

- Agent 保持 Agent 事实的类型所有权；
- Harness 增加 lane/run 上下文；
- Harness 不复制或重新命名整套 Agent Event；
- 上层只需订阅一个 Harness 观察入口。

每种 Harness Event 必须声明自己的持久化语义。例如 `entry_added` 是 commit 后的 durable fact，流式 `agent_event` 通常是 transient fact。不能把所有 Harness Event 一律称为 durable。

### 5.4 Coding Agent

Coding Agent 是产品组合包，拥有：

- 完整的 `CodingToolDefinition`；
- `CodingToolDefinition -> AgentTool` Adapter；
- permission 等 Agent Hook 实现；
- Coding system prompt；
- Tool Presentation 及其 Registry；
- `CodingAgentInteractions` port 与无 UI Adapter；
- 创建 Harness 的组合工厂。

Coding Agent 不重新定义 Agent Tool 或 Agent Hook 的平行别名。它直接实现这些扩展接口。

### 5.5 UI

UI：

- 实现 Coding Agent 定义的 `CodingAgentInteractions`；
- 只通过 `CodingAgentRuntime` 获得并驱动 Harness；
- 订阅 Harness 对外提供的观察流；
- 调用 Coding Agent 提供的 Tool Presentation Registry 渲染结构化工具结果；
- 不被 AI、Agent 或 Harness import。

## 6. Coding Agent 的依赖规则

“Coding Agent 只看到 Harness”分为运行时和构造时两个问题。

### 6.1 运行时只经过 Harness

Harness 构造完成后，Coding Agent 和 UI 只调用：

```text
Harness.prompt()
Harness.abort()
Harness.switchModel()
Harness.subscribe()/events.on()
```

它们不直接调用 Agent Loop、`HookRegistry.trigger()` 或 `AgentTool.execute()`。

### 6.2 构造时允许依赖 Agent 扩展接口

Coding Agent factory 是组合根，必须创建并装配：

- `CodingToolDefinition` 及其 Agent Tool 投影；
- Agent Hook Handler/Registry；
- Harness；
- Coding Tool Presentation Registry；
- Interaction Adapter。

因此构造代码可以诚实地依赖 `agent/hooks` 与 `agent/tools`：

```text
构造阶段：
coding-agent/factory
  -> harness
  -> agent/hooks
  -> agent/tools

运行阶段：
ui -> coding-agent -> harness -> agent -> ai
```

强制 Coding Agent 只能 import Harness，会迫使 Harness 重新导出 Agent 类型、建立无意义别名，或者复制一套没有语义差异的平行概念。这只会隐藏真实依赖。

只有当 Harness Tool 真正增加 replay、durability 或 context resolution 等不同语义时，才定义并翻译 `HarnessTool`。

## 7. Coding ToolDefinition 与两类 UI Adapter

### 7.1 为什么 Coding Agent 需要自己的 ToolDefinition

`AgentTool` 是 Agent 层的执行机制：schema、validation 与 execute。Coding Tool 还需要 Coding 上下文和可选展示策略，因此 Coding Agent 定义一个真正具有不同语义的上层类型，而不是给 `AgentTool` 建立别名：

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

第一版 `CodingToolContext` 只包含 Coding Tool 确实需要且稳定的能力，例如 `cwd`。不得为了方便把 Harness、Session、UI 或任意服务定位器全部塞入 Context。新增字段必须由至少两个合理消费者或一个不可替代的真实需求证明。

### 7.2 Tool Adapter：向下剥离 UI

Coding Agent 提供唯一的投影函数：

```ts
function toAgentTool<
  TParameters extends TObject,
  TDetails,
>(
  definition: CodingToolDefinition<TParameters, TDetails>,
  context: CodingToolContext,
): AgentTool<TParameters, TDetails>;
```

Adapter 向 Agent 投影：

```text
name
description
parameters
execute（闭包捕获 CodingToolContext）
```

Adapter 主动剥离：

```text
presentation
Coding Agent UI 类型
CLI/TUI/Web 类型
```

因此 Agent 与 Harness 在类型级别无法感知 renderer。这个 Adapter 是有意义的翻译层，因为两侧接口和职责确实不同。

### 7.3 Tool Presentation：事实到展示

Coding Agent 定义第一版前端中立、面向行式输出的 Presentation：

```ts
type ToolPresentationOutput = string;

interface CodingToolPresentation<TArguments, TDetails> {
  renderStart(
    call: ToolPresentationCall<TArguments>,
  ): ToolPresentationOutput | undefined;

  renderEnd(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): ToolPresentationOutput | undefined;

  renderRejected?(
    event: ToolPresentationRejected<TArguments>,
  ): ToolPresentationOutput | undefined;
}
```

Presentation 的不变量：

- 只消费已确定的 Agent/Harness 工具事实；
- 不执行工具，不调用 Hook，不改变结果；
- 专用 renderer 缺失、返回 `undefined` 或抛错时使用通用 fallback；
- 第一版只返回 `string`，不提前抽象跨前端 UI tree；
- 真正实现第二类前端后，再根据两个 Adapter 的共同需求提取 presentation model。

`CodingToolPresentationRegistry` 由 Coding Agent 拥有，按 tool name 注册并负责专用 renderer、fallback 与错误隔离。当前位于 `src/ui/tool-renderers.ts` 的 Registry、fallback 和 Todo renderer 领域入口应迁入 `coding-agent/ui/`；终端写入、颜色和 readline 生命周期继续留在 `ui/`。

### 7.4 Hook Interaction Adapter：决策到用户回答

Hook 不需要 Presentation Registry，也不需要 `HookRenderer`。Coding Agent 定义一个窄的双向 port：

```ts
interface CodingAgentInteractions {
  readonly available: boolean;

  confirm(
    request: ConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;

  notify(notification: Notification): void | Promise<void>;
}

interface CodingHookContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}
```

具体 CLI/TUI/RPC 实现是 Interaction Adapter。无 UI 模式使用 fail-closed/no-op Adapter：`confirm()` 返回 `false`，`notify()` 无操作。

Permission Hook 仍然只是普通 Agent Hook Handler：

```ts
registry.register("tool_call", async (call, context, signal) => {
  const allowed = await context.interactions.confirm(request, signal);
  return allowed
    ? undefined
    : { block: true, reason: "permission denied" };
});
```

不增加 `CodingHookDefinition`、`HookUIWrapper` 类或每 Hook 一个 Interaction 方法。`HookRegistry<CodingHookContext>` 加上 `CodingAgentInteractions` 注入已经构成完整 Adapter；再包一层不会增加行为深度。

### 7.5 为什么 Presentation 与 Interactions 分开

```text
模型请求工具
  -> BeforeToolCall Hook
  -> interactions.confirm()       等待用户决定
  -> AgentTool.execute()
  -> tool_end Event
  -> presentation.renderEnd()     展示最终事实
```

二者虽然都与 UI 有关，但接口方向相反：

- Interactions 是前端向 Coding Agent 提供能力；
- Presentation 是 Coding Tool 向前端贡献展示策略。

合并会让一个接口同时承担用户输入、领域数据解释、工具历史展示和执行策略，并随 Tool/Hook 数量膨胀。

### 7.6 content 与 details

`content` 是模型可见表示，`details` 是程序可见结构化数据。二者必须从同一个工具结果来源派生；任何 Hook 修改 `details` 时必须同步返回对应的 `content`，避免模型状态与 UI 状态发散。

Presentation 通过 `CodingToolDefinition<TParameters, TDetails>` 获得对应 Tool 的精确 details 类型。跨 Registry/Event union 造成类型擦除时，校验和收窄集中在 Registry Adapter，不把断言散落到具体 UI。

## 8. Coding Agent Factory 与 Runtime

Factory 的装配顺序固定为：

1. 创建全部 `CodingToolDefinition`；
2. 将每个 definition 投影并注册到 `AgentToolRegistry`；
3. 将每个可选 presentation 注册到 `CodingToolPresentationRegistry`；
4. 创建 `HookRegistry<CodingHookContext>`；
5. 注入 `CodingAgentInteractions` 并注册 permission 等 Coding Hook；
6. 创建 Harness；
7. 返回 `CodingAgentRuntime`。

```ts
interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}
```

UI 只接触 `CodingAgentRuntime`。它通过 `runtime.harness` 驱动会话、订阅事实，通过 `runtime.presentations` 渲染工具事实。UI 不直接 import `AgentToolRegistry`、`HookRegistry` 或调用 Agent Loop。

## 9. Event 对外观察入口

Agent 和 Harness 分别拥有自己的 Event，但 UI 不需要订阅两个运行对象：

```text
AgentEvent
  -> Harness 添加 lane/run envelope
     -> HarnessEvent stream
        -> Coding Agent 对外暴露 Harness
           -> UI 单点订阅
```

Harness Event bus 的被动语义必须固定：

- `publish()` 仅供 Harness 内部调用；
- 外部只有 `subscribe()` 或按类型 `on()`；
- Listener 返回值被忽略；
- Listener 不能阻止持久化或改变控制流；
- Listener 错误被隔离并进入 UI error/telemetry，不改变业务结果；
- 同一 stream 内的顺序保证必须明确；
- 需要“当前状态 + 后续事件”时使用 snapshot/watch，而不是重放所有瞬时 Event。

当前可以继续保留 `subscribe(listener)`。只有在事件数量使消费者频繁手写筛选时，才增加类型化 `on(type, listener)`；二者不能发展成两套事实源。

## 10. 与 Pi 的关系

### 10.1 借鉴

- Agent Core 保持 UI-free；
- Coding Agent 定义 UI interaction port；
- Coding Tool 的执行和 presentation 在上层共同声明，向 Agent 投影时剥离 presentation；
- AgentSession/未来 Harness 将 Agent 事实提升为带 session/run 上下文的上层事实；
- 新 Harness 规格明确区分 Hook 拦截与 passive Event。

Pi 在语义上同样区分两类 UI seam：

- `ExtensionContext.ui` / `ExtensionUIContext` 提供 `confirm`、`select`、`input`、`notify` 等 Interaction；
- `ToolDefinition.renderCall()` / `renderResult()` 提供 Tool Presentation；
- `wrapToolDefinition()` 向 Agent Core 投影时剥掉 renderer。

Kea 保留这种职责划分，但第一版 Presentation 返回 `string`，不直接依赖 Pi TUI `Component`。

### 10.2 不照搬

- 不使用 Pi agent-core 的多个固定 callback 字段；
- 不把控制 Call 与被动 Event 都隐藏在 `ExtensionAPI.on()` 下；
- 不复制三份近似的 Agent/Session/Extension Event；
- 不让 Tool renderer 类型进入 Agent；
- 不把 Pi 新 Harness 尚未接线的 scaffold 当作已验证实现。

Pi 当前用 `Agent callback -> AgentSession -> ExtensionRunner` 桥接控制能力。Kea 的 Agent Loop 直接触发 `HookRegistry`，少一层固定 callback。Pi 当前用 AgentSession 手工转换 Agent Event；Kea 使用 Harness envelope 保留类型所有权。

## 11. 目标目录

长期目标是让 Agent 与 Harness 成为清晰的两个层次：

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
    hooks/
    events/
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
    types.ts

  ui/
    cli-frontend.ts
    cli-harness-renderer.ts
    cli-interactions.ts
```

目录迁移应与真实 Harness Hook/Event 实现一同进行，不为目录美观提前制造兼容转发文件。

## 12. 当前与未来的实施边界

### 当前保留

- `src/agent/hooks/` 的 `AgentHookCall + ResultOf + HookRegistry`；
- Agent Tool 位于 Agent 层；
- Coding Agent factory 装配 permission Hook、Coding Tools 和 Harness；
- UI 只被 Coding Agent 感知；
- Tool renderer 与 Agent Tool 分离。

### 下一阶段修改

- Agent 自己拥有 Agent Hook trigger，不再让 HarnessConfig 无语义地向 Agent Loop 透传 Hook；
- Harness 增加自己的 Event 类型和观察模块；
- Harness 用 `agent_event` envelope 提升 Agent Event；
- UI 改为只订阅 Harness 观察入口；
- 增加方案 B 的 `CodingToolDefinition` 与 `toAgentTool()` Adapter；
- 把 Tool Presentation 接口、Registry、fallback 和默认 renderer 所有权移入 Coding Agent；
- 将 `CodingHookUI` 泛化并重命名为 `CodingAgentInteractions`，通过 `CodingHookContext` 注入；
- Coding Agent factory 返回 `CodingAgentRuntime`，同时封装 Harness 与 Presentation Registry；
- 文档中的“Hook event”统一改称 Hook Call。

### 推迟

- Harness Hook：等 compaction/navigation/run 等真实决策出现时实现；
- 通用 `hooks/registry-core`：等第二个真实 Registry 使用者出现时提取；
- ExtensionHost 和第三方动态加载；
- TUI/Web presentation 抽象；
- `watch()` 的 snapshot、buffer 与恢复协议。

## 13. 验收标准

后续实现必须满足：

1. Agent 可以脱离 Harness 单独运行并使用 Agent Hook；
2. Agent 不 import Harness，Harness 不 import Coding Agent，核心层不 import UI；
3. Harness Hook 不进入 `AgentHookCall`，也不穿入 Agent Loop；
4. Coding Agent 运行时只驱动 Harness，构造时可以直接实现 Agent Hook/Tool 接口；
5. Hook Handler 返回值可以按契约控制执行，Event Listener 返回值永远无效；
6. UI 通过单一 Harness 观察入口获得 Agent 与 Harness 事实；
7. Agent Event 通过 envelope 提升，不复制成近似 Harness 事件；
8. Tool renderer 不进入 Agent/Harness 类型；
9. 不增加中央 `AgentHookMap`、全局 `HookCall` 或全局 `KeaEvent`；
10. 新增 Hook 决策点必须由行为所有者定义并显式触发；
11. 每个 Coding Tool 通过一个 `CodingToolDefinition` 共同声明执行和可选 Presentation；
12. `toAgentTool()` 投影不包含任何 Presentation 或 UI 类型；
13. Tool Presentation 失败只能触发 fallback，不能改变 Agent/Harness 执行；
14. Hook UI 只通过 `CodingAgentInteractions` 请求 `confirm`/`notify`，不建立 Hook renderer；
15. UI 只接触 `CodingAgentRuntime`，不直接装配 Agent Tool 或 Hook；
16. 第一版 Tool Presentation 输出保持 `string`，不引入未被第二前端证明的 UI 抽象。
