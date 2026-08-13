# 统一 Event System 设计

## 1. 目标

Kea 当前用三条链路处理运行过程：

- Agent Loop 通过 `yield` 交出运行事实；
- Harness 通过 `publish()` 把事实交给 UI；
- Hook 通过 `trigger()` 在行为发生前进行干预。

这三条链路描述的是同一个运行过程，却拥有不同的注册、分发、错误和类型机制。新的设计用一套 Event System 同时承载事实通知和行为干预，并删除旧链路，而不是在旧架构旁增加第四套机制。

本次改造只重建事件基础设施及其直接调用链。Todo、工具展示方式和整体 UI 架构不重新设计；Permission 用来验证可干预事件能够替代旧 Hook。

## 2. 各层的核心职责

### AI：一次模型请求

`StreamFn` 接收模型、消息和工具定义，持续返回模型生成的数据。这个流是模型响应的传输协议，不是应用扩展机制。

为了避免与运行时 Event 混淆，流中的元素统一称为 `StreamChunk`。AI 层继续使用 `AsyncIterable<StreamChunk>`。

### Agent：一次 Agent Run

一次 `runAgentLoop()` 调用完成一次 Agent Run。它接收一条用户输入，可能执行多个模型请求和工具调用，直到完成、取消或失败。

`runAgentLoop()` 不再向上返回事件流：

```ts
async function runAgentLoop(...): Promise<void>
```

它通过 Event System 公布过程，通过 `AgentContext.appendMessage()` 提交消息，通过 Promise 表示本次调用是否结束。

### Harness：一个 Session

Harness 持有 Session，启动 Agent Run，并管理 `sessionId`、`runId`、`lane`、取消、模型和持久消息。

### Coding Agent：一个 Project

Coding Agent 管理 Project 及其多个 Session，并为这些 Session 组装 coding prompt、tools、Permission、interactions 和 presentation。一个 Project 只创建一个 Event System 实例。

## 3. 唯一的 Event System

Event System 是跨层基础模块。一个 Project 中的所有 Harness 和 Agent Run 共用同一个实例。它不是进程级单例；两个 Project 的事件互不相通。

Agent、Harness 和 Coding Agent 可以声明和使用各自拥有的事件，但不能创建平行的 EventBus，也不能转发或重新包装下层事件。

事件来源通过载荷区分：

- `sessionId` 表示事件属于哪个 Session；
- `runId` 表示事件属于该 Session 的哪一次 Agent Run；
- `lane` 表示事件属于哪条运行通道，当前只有 `main`。

Project 已经由 Event System 实例隔离，因此 Session 和 Run 事件不重复携带 `projectId`。

## 4. 三种分发方式

Event System 对外只有一套注册机制：

```ts
events.on(name, listener): Unregister
```

`Unregister` 可重复调用，只有第一次生效。一次分发开始时快照当前监听器；分发期间的注册变化从下一次分发开始生效。

### `emit()`：发布事实

```ts
await events.emit("agent/tool-start", payload);
```

`emit()` 表示某件事已经发生：

- 按注册顺序调用并等待所有监听器；
- 监听器返回值没有意义；
- 单个监听器失败会交给 `onListenerError`；
- 失败不会阻止后续监听器，也不会改变 Agent Run。

等待监听器保留了 Kea 当前 `publish()` 的事件顺序。它不同于 DSH 的 fire-and-forget 通知，因为 Kea 尚未拥有 DSH 那样完整的持久 Session Event Log。

### `ask()`：依次询问

```ts
const answer = await events.ask("agent/user-prompt", payload, signal);
```

`ask()` 按注册顺序询问监听器。第一个非空回答成为最终结果；没有监听器回答时返回 `undefined`。监听器异常向调用者传播，因为询问发生在行为确定以前。

### `transform()`：逐步修改

```ts
const result = await events.transform("agent/context", value, signal);
```

`transform()` 使用中间件形式：

```ts
async (value, next, signal) => next(modifiedValue)
```

监听器调用 `next()` 时，修改后的值进入下一个监听器；直接返回而不调用 `next()` 时，变换在当前位置结束。这允许普通修改，也允许 Permission 之类的监听器作出不可被后续监听器推翻的拒绝。异常向调用者传播。

`emit()`、`ask()` 和 `transform()` 是同一个 Event System 的三种分发语义，不是三个 EventBus。

## 5. 类型扩展

通用 Event System 不包含 Agent 或 Harness 的事件名称，也不按事件名称编写 `switch`。每个事件契约在类型层声明：

```ts
interface EventContract<TMode, TInput, TResult = void> {
  readonly mode: TMode;
  readonly input: TInput;
  readonly result: TResult;
}

interface Events {}
```

各层通过 TypeScript 声明合并扩充 `Events`：

```ts
declare module "../events/index.js" {
  interface Events {
    "agent/tool-start": EventContract<"emit", ToolStartPayload>;
  }
}
```

事件契约中的 `mode` 只用于类型检查：

- `emit()` 只能接收 `mode: "emit"` 的事件；
- `ask()` 只能接收 `mode: "ask"` 的事件；
- `transform()` 只能接收 `mode: "transform"` 的事件；
- `on()` 根据 mode 推导监听器签名。

因此新增事件只需要在行为所属层声明契约，并在真实发生的位置分发。通用 Event System 不需要修改。

## 6. Event System 的传递

Coding Agent 的工厂创建 Event System，安装 Permission 等内置监听器，然后把同一实例交给所有 Harness。

Harness 启动 Run 时生成运行身份：

```ts
const run = { sessionId, runId, lane };
```

Harness 用这套系统发布 `harness/run-start` 和 `harness/run-end`。Agent Loop 接收同一实例和运行身份，直接分发 Agent 事件。

Agent 事件从产生时就带有完整身份，不再经过 `liftAgentEvent()`。UI 从 Project 暴露的 Event System 订阅事件，不再调用 `harness.subscribe()`。本次只迁移 UI 的事件输入，不改变其渲染结构或 Session 控制接口。

独立使用 Harness 时，调用方必须提供一个 Event System；Harness 不隐式创建第二个实例。

## 7. Agent 与 Harness 事件

Harness 拥有 Run 边界：

- `harness/run-start`；
- `harness/run-end`。

Agent 拥有 Run 内部事实：

- Turn 开始和结束；
- 文本与思考增量；
- 模型生成 Tool Call 的开始、增量和结束；
- Tool 执行的开始、结束和拒绝。

原来的 `agent_start` 和 `agent_end` 与 Harness Run 边界重复，因此删除。`runAgentLoop()` 的 Promise 是程序控制边界，`harness/run-end` 是提供给观察者的事实，两者不能互相替代。

事件定义按行为所属层分别放置，但它们都注册到同一个 `Events` 类型，并通过同一个 Event System 实例分发。不存在 `AgentEvent -> HarnessEvent` 的类型转换。

## 8. 消息持久化

Event System 负责实时分发，不负责保存 Session。Session 仍然保存用户消息、Assistant 消息、Tool Result、模型变更和标题。

`AgentContext` 改为明确的消息提交接口：

```ts
interface AgentContext {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolRegistry;
  appendMessage(message: AgentMessage): Promise<void>;
}
```

Harness 实现 `appendMessage()`：

1. 将消息写入 Session；
2. 写入成功后更新内存消息；
3. 第一条用户消息提交后，可以启动异步标题生成。

完整消息先提交，再发布完成事实：

```ts
await context.appendMessage(assistantMessage);
await events.emit("agent/turn-end", payload);
```

模型生成中的文本增量只实时发布；最终 Assistant Message 完成后才整体提交。

这保留了 Agent 与 Session 的边界：Agent 只知道如何提交消息，不依赖 Harness 的 `Session` 类。它也删除了 `yield` 暂停后才能运行的 `persistNewMessages()` 和 `persistedMessageCount`。

## 9. 原 Hook 触发点的迁移

原有五个 Hook 行为并入普通事件契约：

| 事件 | 分发方式 | 行为 |
|---|---|---|
| `agent/user-prompt` | `ask()` | 是否拒绝用户输入 |
| `agent/context` | `transform()` | 修改发给模型的消息 |
| `agent/tool-call` | `transform()` | 修改或拒绝 Tool Call |
| `agent/tool-result` | `transform()` | 修改 Tool Result |
| `agent/stop` | `ask()` | 是否增加消息并继续运行 |

Tool Call 同时需要修改和拒绝能力，因此其变换值明确表示当前决定：

```ts
type ToolCallDecision =
  | { readonly kind: "execute"; readonly call: AgentToolCall }
  | { readonly kind: "reject"; readonly call: AgentToolCall; readonly reason: string };
```

原始 Tool Call 保持不变。监听器传递或修改 `execute.call`；需要拒绝时直接返回 `reject`，不调用 `next()`。Agent Loop 根据最终决定执行或生成拒绝结果。

## 10. Permission

Permission 不再实现 Hook。Coding Agent 在 Project Event System 上注册 `agent/tool-call` 监听器：

- 非 Bash 调用继续传递；
- 明确安全的 Bash 调用继续传递；
- 策略明确拒绝时直接返回 `reject`；
- 需要用户决定时调用 `interactions.confirm()`；
- 确认失败或用户拒绝时返回 `reject`。

Permission UI 仍然由 `CodingAgentInteractions` 提供。本次不改造 interactions，也不把 UI 放进 Agent、Harness 或 Event System。

## 11. 错误与取消

每次 Run 继续使用独立的 `AbortController`。模型请求、Tool、`ask()` 和 `transform()` 接收同一个 `AbortSignal`。每个异步控制点返回后，Agent Loop 重新检查信号，确保取消优先于监听器结果。

错误由拥有行为的模块解释：

- `emit()` 监听器错误只报告，不影响 Run；
- user-prompt、context 或 stop 的干预监听器错误使 Run 失败；
- tool-call 干预失败按拒绝处理，不能默认执行工具；
- tool-result 干预失败生成错误 Tool Result；
- Permission 确认失败按拒绝处理。

`runAgentLoop()` 正常完成时履行 Promise，系统错误时拒绝 Promise。AI 层返回的终止错误消息仍作为 Assistant Message 提交后正常结束，以保持现有模型错误语义。

Harness 一旦成功发布 `harness/run-start`，就必须恰好发布一次 `harness/run-end`：

- 正常完成：`completed`；
- AbortSignal 已取消：`aborted`；
- 其他异常：`error`。

`harness/run-end` 监听器不能改变已经确定的结果。

## 12. 文件与删除范围

通用实现放在顶层 `src/events/`。Agent 和 Harness 分别保留自己的事件契约；Coding Agent 的 `events/` 只负责安装 Project 级监听器，例如 Permission。

删除以下旧机制：

- `src/agent/hooks/` 及全部 Hook 类型；
- `AgentLoopConfig.hooks` 和所有 `hooks.trigger()`；
- `AgentEvent` 联合与 Agent Loop 中的全部 `yield`；
- `HarnessEventBus`、`publish()`、`HarnessEvent` 和 `liftAgentEvent()`；
- Harness 的 `runPrompt()` 生成器；
- `persistNewMessages()` 和 `persistedMessageCount`；
- Coding Agent 的 `hooks/` 和 `createCodingHooks()`；
- UI 对 `harness.subscribe()` 的依赖。

保留 AI `StreamFn` 的异步流，但将其元素视为 `StreamChunk`，不把它作为另一套运行时 Event。

## 13. 验收标准

1. 一个 Project 只创建一个 Event System，所有 Session 和 Run 共用它。
2. 代码中不再存在 HookRegistry、Hook trigger、Agent Loop `yield`、Harness EventBus 或事件提升。
3. `runAgentLoop()` 返回 `Promise<void>`。
4. 所有运行时通知和干预都经过 `on()`、`emit()`、`ask()`、`transform()`。
5. 新事件能够由所属层扩充类型，不修改通用 Event System。
6. UI 监听器失败不会中断 Run；干预监听器错误按事件拥有者的规则处理。
7. 消息写入失败时不发布对应的完成事实，也不更新内存消息。
8. `harness/run-start` 与 `harness/run-end` 一一对应。
9. Permission 能允许、询问或拒绝 Bash Tool Call，确认失败时默认拒绝。
10. 多个 Session 并行发布时，UI 能通过 `sessionId`、`runId` 和 `lane` 区分来源。

## 14. 与 DSH 的关系

Kea 学习 DSH 的一套事件基础设施、多种分发语义和可扩展类型声明。两者的运行模型不同：DSH 的 Agent 是常驻驱动器，`followup()` 只入队，调用方用 `whenIdle()` 等待停稳，运行事实主要进入持久 Session Event Log；Kea 保留一次 `runAgentLoop()` 对应一次 Agent Run、Harness 管理 Session 的边界。

因此 Kea 不复制 DSH 的 Inbox、常驻 Agent 或 fire-and-forget 通知。统一 Event System 服务于 Kea 已经确定的 AI Request、Agent Run、Harness Session、Coding Project 四层模型。
