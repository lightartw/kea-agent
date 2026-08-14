# events

`events` 是 Kea 各模块共同使用的通信机制。它让产生行为的模块说明“现在发生了什么”或“某个行为提交前需要什么”，而不必直接依赖日志、权限、CLI 或其他使用者。

## 1. Event 是什么

Event 是系统生命周期中一个有名字的时点。注册者把 listener 函数挂在这个名字下，行为发生时 `Events` 调用这些 listener。

每种 Event 包含两部分：

- **名字**：指出发生了什么，例如 `agent/turn-end`；
- **数据**：描述这次事件，例如完整 assistant message 和它产生的 Tool Result。

Event 不一定只表示“已经发生的事实”。Kea 也用它表示行为执行前的控制点。区分这两种语义的是注册的 listener 签名，而不是 Event 本身的名字。

## 2. `EventMap`：事件目录

`EventMap` 是编译期接口，描述哪些事件名合法、每个事件名的 listener 长什么样。它只做类型检查，不保存 listener，也不负责分发。

拥有某个行为的模块在自己的 `events.ts` 中扩充 `EventMap`。例如：

```ts
declare module "./types.js" {
  interface EventMap {
    "example/started": (
      input: { readonly id: string },
    ) => void | Promise<void>;
    "example/permission": (
      input: { readonly command: string },
      proceed: (input: { readonly command: string }) => Promise<string | undefined>,
      signal?: AbortSignal,
    ) => string | undefined | Promise<string | undefined>;
  }
}
```

两种 listener 签名对应两种分发规则：

- 只接收一个 `input`、返回 `void` 的 listener 用于 `emit()`；
- 接收 `input`、`proceed` 和可选 `signal` 的 listener 用于 `intercept()`。

## 3. `Events`：运行时分发器

`Events` 是真正运行的类。一个 Project 创建一个 `Events` 实例，该 Project 的所有 Session 和 Run 共用它，因此 UI、Permission 和日志只需向这个实例注册。

`Events` 提供三个方法：

- `on(name, listener)`：注册一个 listener；
- `emit(name, input)`：把事实通知给全部 listener；
- `intercept(name, input, handler, signal?)`：让 listener 包裹一个待执行的行为。

## 4. `on()`：注册

`events.on(name, listener)` 把 listener 注册到“当前 `events` 实例的这个事件名”下。它返回一个函数，调用它取消这一次注册。

- 同一事件名的 listener 按 `on()` 调用先后排序；
- 同一个函数注册两次是两次独立注册，返回的取消函数各管各的；
- 取消函数幂等，重复调用只有第一次生效；
- 分发开始时取得当时的注册快照，分发期间的注册变化下一次分发才生效。

```ts
const unregister = events.on("example/started", handler);
unregister();  // 之后的分发不再调用 handler
```

## 5. `emit()`：发布事实

`emit(name, input)` 按注册顺序调用当前 `Events` 实例中注册到该事件名的全部 listener。它等待前一个 listener 结束后再调用下一个；listener 的返回值被忽略。

某个 listener 失败时，错误交给可选的错误处理器，后续 listener 仍继续执行。错误处理器自身失败不会打断分发。没有 listener 时，`emit()` 直接结束。

`emit()` 用于发布已经发生的事实，观察者不能改变事实，也不能中断其他观察者。

## 6. `intercept()`：包裹一个待执行的行为

`intercept(name, input, handler, signal?)` 让注册的 listener 依次包裹一个最终 `handler`。`handler` 接收修改后的输入并返回结果。

listener 按注册顺序执行，每个 listener 收到：

- 当前的 `input`；
- `proceed(changedInput)`：把修改后的输入交给下一个 listener（最后一个 listener 之后是 `handler`）。

```ts
const result = await events.intercept(
  "example/permission",
  { command: "rm file.txt" },
  async (effective) => effective.command,
);
```

listener 不调用 `proceed()` 而直接返回时，链在当前位置结束，`handler` 不执行。每个 listener 最多调用一次 `proceed()`，第二次调用抛出明确错误且不再执行下游。

listener 失败时，`intercept()` 失败并传播给行为拥有者。`intercept()` 在分发前、进入每一层前和每个 awaited listener 返回后检查 `AbortSignal`。

## 7. 错误与取消

`Events` 构造时可选接收一个错误处理器，它接收 `(error, name, input)`。它只报告 `emit()` listener 的失败，因为事实 listener 没有权限中断运行。`intercept()` 的 listener 失败直接传播，不经过错误处理器。

`emit()` 不接收 `AbortSignal`——已经发生的事实不会被取消。`intercept()` 接收信号，用于行为提交前的控制链。

## 8. 谁拥有哪些 Event

- **Harness** 声明并分发 Run 边界：`harness/run-start`、`harness/run-end`；
- **Agent** 声明并分发一次 Run 内的 Turn 与 Tool 事实，以及三个控制点；
- **Coding Agent** 注册 Project 级 listener（例如 Permission），并创建共享 `Events`；
- **UI** 只订阅展示需要的事实，用 `sessionId` 过滤。

## 9. 最终生命周期

用户提交一次 prompt 后，事件按下面的顺序发生：

```text
harness/run-start
agent/user-prompt
agent/turn-start
agent/context
agent/text-delta | agent/thinking-delta | agent/tool-call-start | agent/tool-call-delta
agent/tool-call
tools/pre-execute
tools/execute
tools/post-execute
agent/tool-result
agent/turn-end
shouldContinue() decides internally
agent/stopping (only when the loop would otherwise stop)
harness/run-end
```

几点说明：

- 四个流式事实（`agent/text-delta`、`agent/thinking-delta`、`agent/tool-call-start`、
  `agent/tool-call-delta`）只在 provider 产生对应片段时发生；
- 中间的五行（`agent/tool-call` 到 `agent/tool-result`）对 assistant 消息中的每个 Tool Call
  各重复一次，顺序与模型生成顺序一致；
- 未知、无效、被阻止、已中止或失败的 Tool Call 跳过无法执行的阶段，但仍然以恰好一个
  `agent/tool-result` 结束；
- `shouldContinue()` 是 Agent Loop 内部的决策，不产生事件；只有 Loop 将要停止时才分发
  `agent/stopping`。

## 10. 公共接口

`src/events/index.ts` 导出：

- `Events`：运行时分发器；
- `EventMap`：事件目录接口。

条件辅助类型（事实/拦截事件名、输入和结果推导）只供 `src/events/events.ts` 内部实现使用，不通过入口暴露。
