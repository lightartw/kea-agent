# events

`events` 是 Kea 各模块共同使用的通信机制。它让产生行为的模块通过 `emit()` 说明“现在发生了什么”，或通过 `intercept()` 允许 listener 参与一个待执行的行为，而不必直接依赖日志、权限、CLI 或其他使用者。

## 1. Event 是什么

Event 是系统生命周期中一个有名字的时点。注册者把 listener 函数挂在这个名字下，行为发生时 `Events` 调用这些 listener。

每种 Event 包含两部分：

- **名字**：指出发生了什么，例如 `agent/turn-end`；
- **数据**：描述这次事件，例如完整 assistant message 和它产生的 Tool Result。

Event 不一定只表示已经发生的事情。Kea 也用 event 表示可以被 listener 改变或阻止的行为。`EmitEvent` 声明由 `emit()` 分发的 event，`InterceptEvent` 声明由 `intercept()` 分发的 event。

## 2. `EventMap`：事件目录

`EventMap` 是编译期接口，描述 event 名、输入和结果。它不要求各模块手写 listener 函数类型；`Events.on()` 会根据 `EmitEvent` 或 `InterceptEvent` 自动生成正确的 listener 类型。`EventMap` 只做类型检查，不保存 listener，也不负责分发。

拥有某个行为的模块在自己的 `events.ts` 中扩充 `EventMap`。例如：

```ts
import type { EmitEvent, InterceptEvent } from "./types.js";

declare module "./types.js" {
  interface EventMap {
    "example/started": EmitEvent<{ readonly id: string }>;
    "example/permission": InterceptEvent<
      { readonly command: string },
      string | undefined
    >;
  }
}
```

每个声明只包含 event 自身的信息：

- `EmitEvent<Input>` 声明 `emit()` 的输入；
- `InterceptEvent<Input, Result>` 声明 `intercept()` 的输入和结果。

注册 listener 时，`on()` 根据这个声明自动提供函数类型：emit listener 接收 `input`；intercept listener 接收 `input`、`proceed` 和可选的 `signal`。因此 event 的拥有者不需要重复 `proceed`、`signal` 和异步返回类型。

## 3. `Events`：运行时分发器

`Events` 是真正运行的类。一个 Project 创建一个 `Events` 实例，该 Project 的所有 Session 和 Run 共用它，因此 UI、Permission 和日志只需向这个实例注册。

`Events` 提供三个方法：

- `on(name, listener)`：注册一个 listener；
- `emit(name, input)`：把 event 依次交给全部 listener；
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

## 5. `emit()`：分发 event

`emit(name, input)` 按注册顺序调用当前 `Events` 实例中注册到该事件名的全部 listener。它等待前一个 listener 结束后再调用下一个；listener 的返回值被忽略。

某个 listener 失败时，错误交给可选的错误处理器，后续 listener 仍继续执行。错误处理器自身失败不会打断分发。没有 listener 时，`emit()` 直接结束。

`emit()` 用于分发已经发生的 event。listener 不能改变这次 event，也不能中断其他 listener。

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

`Events` 构造时可选接收一个错误处理器，它接收 `(error, name, input)`。它只报告 `emit()` listener 的失败；`intercept()` 的 listener 失败直接传播，不经过错误处理器。

`emit()` 不接收 `AbortSignal`——已经开始分发的 event 不会被取消。`intercept()` 接收信号，用于取消尚未完成的行为。

## 8. 谁拥有哪些 Event

- **Harness** 声明并分发 Run 边界：`harness/run-start`、`harness/run-end`；
- **Agent** 声明并分发一次 Run 内的 Turn、Tool 和流式 event，以及两个 intercept event；
- **Coding Agent** 注册 Project 级 listener（例如 Permission），并创建共享 `Events`；
- **UI** 通过 `on()` 注册展示所需的 listener，并用 `sessionId` 过滤 event。

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
maxTurns hard-limit check
stop when toolResults is empty
harness/run-end
```

几点说明：

- 四个流式 event（`agent/text-delta`、`agent/thinking-delta`、`agent/tool-call-start`、
  `agent/tool-call-delta`）只在 provider 产生对应片段时发生；
- 中间的五行（`agent/tool-call` 到 `agent/tool-result`）对 assistant 消息中的每个 Tool Call
  各重复一次，顺序与模型生成顺序一致；
- 未知、无效、被阻止、已中止或失败的 Tool Call 跳过无法执行的阶段，但仍然以恰好一个
  `agent/tool-result` 结束；
- 每个正常 Turn 的 `agent/turn-end` 后，Agent Loop 先检查不可绕过的 `maxTurns`，再按
  `toolResults.length === 0` 直接决定是否结束；产生 Tool Result 时开始下一 Turn 让模型消费它们。

## 10. 公共接口

`src/core/events/index.ts` 导出：

- `Events`：运行时分发器；
- `EventMap`：event 目录接口；
- `EmitEvent`：声明 `emit()` event 的输入；
- `InterceptEvent`：声明 `intercept()` event 的输入和结果。

条件辅助类型（emit/intercept event 名、listener、输入和结果推导）只供 `src/core/events/events.ts` 内部实现使用，不通过入口暴露。
