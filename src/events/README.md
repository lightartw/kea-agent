# events

`events` 是项目的运行事件通道。它提供一个编译期契约 `EventMap` 和一个运行时对象 `Events`，
让不同包在同一个 Project 内声明、分发和监听事件。

## 1. Event 与 Events

先区分两个名字相似的概念：

- **Event** 是运行过程中需要分发的一项信息。它可能是已经发生的事实，也可能是行为提交前
  需要取得的答案或新值。
- **`Events`** 是运行时对象。listener 通过 `on()` 注册到它上面，代码通过 `emit()`、`ask()`
  或 `transform()` 找到并调用这些 listener。

一次分发只发生在同一个 `Events` 实例内部：注册者用 `events.on(...)` 把 listener 放在某个
事件名下，分发者用同一个 `events` 调用对应方法。

最小使用：

```ts
import { Events } from "./index.js";

const events = new Events();

events.on("example/started", (input) => {
  console.log(`started ${input.id}`);
});

await events.emit("example/started", { id: "task-1" });
```

`example/started` 必须先在 `EventMap` 里声明，上面的调用才能通过类型检查（见第 4 节）。
上面的例子假设声明是 `EventContract<"emit", { id: string }>`。

## 2. on() 与注册顺序

`events.on(name, listener)` 把 listener 注册到“当前 `events` 实例的这个事件名”下。它返回
一个 `Unregister` 函数，调用它取消这一次注册。

- 后续对同一实例、同一事件名的分发才会调用这个 listener；
- 同一事件名的 listener 按 `on()` 调用先后排序；
- **同一个函数注册两次也是两次独立注册**；`unregister()` 只取消对应的那一次；
- `unregister()` 幂等，重复调用只有第一次生效；
- 分发开始后使用注册快照，本次过程中发生的注册变化下一次分发才生效。

```ts
const unregister = events.on("example/started", handler);
unregister();  // 之后的分发不再调用 handler
```

## 3. 三种分发方式

### emit()：调用全部 listener

`emit(name, input)` 按注册顺序调用当前 `Events` 实例中注册到该事件名的全部 listener。它等待
前一个 listener 结束后再调用下一个；listener 的返回值被忽略。

某个 listener 失败时，失败交给错误报告器，后续 listener 仍继续执行。`emit()` 用于发布已经
发生的事实，观察者不能改变事实，也不能中断其他观察者。

### ask()：依次请求一个答案

`ask(name, input, signal)` 按注册顺序询问当前 `Events` 实例中注册到该事件名的 listener。
listener 返回 `undefined` 表示不回答；第一个非 `undefined` 值成为最终答案，之后的 listener
不再调用。如果全部 listener 都不回答，`ask()` 返回 `undefined`。

listener 失败时，`ask()` 失败并停止询问；错误不经过错误报告器。分发前和每个异步 listener
返回后检查 `AbortSignal`。`ask()` 用于让某一个 listener 对即将发生的行为作出决定。

### transform()：让一个值经过 listener 链

`transform(name, value, signal)` 把同一个类型的值交给第一个 listener。listener 调用
`next(newValue)` 时，`newValue` 进入下一个 listener；不调用 `next()` 就返回时，后续 listener
不再执行。外层 listener 可以等待下游结果，再修改并返回最终值。

一个两层示例：

```ts
events.on("example/context", async (value, next) => {
  const downstream = await next([...value, "middle"]);
  return [...downstream, "outer"];
});
events.on("example/context", (value) => [...value, "inner"]);

const result = await events.transform("example/context", ["start"]);
// result === ["start", "middle", "inner", "outer"]
```

进入顺序是注册顺序：`["start"]` → 第一个 listener → `next([...])` 进入第二个 listener →
`["start", "middle", "inner"]` 沿链返回 → 第一个 listener 收到下游结果并追加 `"outer"`。

每个 listener 最多调用一次 `next()`。第二次调用抛出明确错误，且不会再执行下游 listener。
listener 失败时，`transform()` 失败；分发前、进入每一层前和 listener 返回后检查
`AbortSignal`。`transform()` 用于同一个值在提交前经过多层修改。

## 4. EventMap：编译期契约

`EventMap` 不保存 listener，也不负责分发。它只让 TypeScript 检查事件名、模式、输入和答案
类型。每个事件模块通过模块扩充声明自己的契约：

```ts
declare module "./types.js" {
  interface EventMap {
    "example/started": EventContract<"emit", { readonly id: string }>;
    "example/permission": EventContract<
      "ask",
      { readonly command: string },
      boolean
    >;
    "example/context": EventContract<"transform", readonly string[]>;
  }
}
```

`EventContract` 的三个参数是 `TMode`、`TInput`、`TResult`：

- `emit` 不需要结果，只写输入；
- `ask` 写输入和答案类型 `TResult`；
- `transform` 的输入和结果是同一种类型，只写一次 `TValue`。

事件模块负责声明契约；拥有该行为的代码负责选择正确时点分发。

## 5. 一份 Project 的 Events 如何贯穿各层

在 Kea 中，一份 Project 创建一份 `Events`，项目里的 Harness、Agent Run、Coding Agent listener
和 UI 使用同一个实例。

先定义几个概念：

- **Project** 是 Coding Agent 管理的一组目录和 Session；它创建一份 `Events`。
- **Session** 是一段可恢复的对话历史。
- **Run** 是 Harness 对一次用户输入启动的一次 Agent 执行。

同一 Project 的 Harness、Agent Run、Coding Agent listener 和 UI 使用同一份 `Events`。事件用
`sessionId`、`runId`、`lane` 标识所属运行，UI 据此筛选自己展示的 Session：

```ts
project.events.on("agent/turn-end", (input) => {
  if (input.sessionId !== selectedSessionId) return;
  render(input.message);
});
```

各层的职责分工：

- **Agent** 声明并分发 Agent Run 的事实与控制事件（`agent/*`）；
- **Harness** 声明并分发 Session Run 边界（`harness/run-start`、`harness/run-end`）；
- **Coding Agent** 注册 permission 等产品能力，并创建这份共享的 `Events`；
- **UI** 只订阅展示需要的事实，用 `sessionId` 过滤。

## 6. 进阶行为

### listener 快照

一次分发开始时复制当时的注册列表。分发过程中调用 `on()` 或 `unregister()` 不会影响本次
正在进行的调用顺序，从下一次分发开始生效。

### 取消

`ask()` 和 `transform()` 接收 `AbortSignal`：分发前和每个异步 listener 返回后检查信号，已
取消时抛出 `AbortError`。`emit()` 不接收信号——已经发生的事实不会被取消。

### 错误报告

`Events` 构造时可选接收一个 `EventListenerErrorHandler`。它只报告 `emit()` listener 的失败，
因为事实 listener 没有权限中断运行。报告器自身失败时，错误不会再进入事件系统，也不会改变
本次 `emit()` 的结果。

### 公共接口

`src/events/index.ts` 只导出：

- `Events`（值）；
- `EventMap`、`EventContract`、`EventMode`、`Unregister`、`EventDispatch`、
  `EventListenerErrorHandler`（类型）。

`EventName`、`EventInput`、`EventResult` 和 listener 推导类型属于实现细节，供包内使用，不通过
入口暴露。

### 依赖方向

`events` 只依赖 TypeScript 类型系统，不依赖 agent、harness、coding-agent 或 UI。其他包在
`EventMap` 上声明自己的契约，并用 `Events` 分发。

## 7. 新增一个事件

新增事件的完整步骤：

1. 在拥有该事件的层扩充 `EventMap`：选择 `emit`、`ask` 或 `transform`，写出输入和结果类型；
2. 在行为发生的准确位置分发：事实用 `emit()`，需要决策用 `ask()`，提交前修改用
   `transform()`；
3. 在组合层注册 listener（例如 Coding Agent 注册 permission listener）；
4. 为顺序、返回值和错误语义写测试。
