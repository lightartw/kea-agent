# Events 行为与文档设计

## 1. 目标

完善 `Events` 的注册、分发、变换和错误语义，修复 Agent 与 Harness 在异常边界上的错误处理，并为 `src/events/` 增加一份面向首次使用者的渐进式 README。

用户文档只解释当前代码。它不介绍已经删除的实现、迁移过程或设计中的废案。

## 2. Events 的核心概念

一个 Event 表示运行过程中发生的一件事，或者某个行为提交前需要完成的一次询问或变换。

`EventMap` 是编译期契约，定义事件名、分发方式、输入和答案类型。`Events` 是运行时分发器，保存 listener 注册并执行分发。一个 Project 创建一个 `Events`，该 Project 的 Harness、Agent Run 和 UI 使用同一个实例。

`Events` 的用户接口由四个方法组成：`on()`、`emit()`、`ask()` 和 `transform()`。

## 3. 注册

```ts
const unregister = events.on(name, listener);
```

`on()` 把一次 listener 注册保存到当前 `Events` 实例的指定事件名下。

- 调用顺序等于注册顺序；
- 每次 `on()` 都创建独立注册，即使传入同一个函数；
- `unregister()` 只删除对应的这一次注册；
- `unregister()` 可以重复调用，只有第一次生效；
- 一次分发开始时取得注册快照，分发期间的注册变化从下一次分发开始生效。

## 4. 三种分发方式

### `emit()`：调用全部 listener

```ts
await events.emit(name, input);
```

`emit()` 按注册顺序调用当前实例中属于该事件名的全部 listener。它等待前一个 listener 结束后再调用下一个；listener 返回值被忽略。

一个 listener 失败时，`emit()` 把失败交给错误报告器，然后继续调用后续 listener。错误报告器是诊断链的终点；如果它自身失败，失败不会重新进入事件系统，也不会改变本次 `emit()`。

`emit()` 用于发布已经发生的事实。

### `ask()`：依次请求一个答案

```ts
const answer = await events.ask(name, input, signal);
```

`ask()` 按注册顺序调用该事件的 listener：

- listener 返回 `undefined` 时继续调用下一个；
- 第一个非 `undefined` 返回值成为最终答案；
- 得到答案后不再调用后续 listener；
- 没有 listener 回答时返回 `undefined`；
- listener 失败时，`ask()` 失败；
- 分发前和每个异步 listener 返回后检查 AbortSignal。

`ask()` 用于让某一个 listener 对即将发生的行为作出决定。

### `transform()`：让一个值经过 listener 链

```ts
const result = await events.transform(name, value, signal);
```

Transform 事件的输入和输出必须是同一种类型。第一个 listener 接收初始值；调用 `next(modifiedValue)` 后，修改后的值进入下一个 listener。

- listener 顺序等于注册顺序；
- 不调用 `next()`、直接返回一个值时，链在当前位置结束；
- 最后一个 listener 调用 `next(value)` 时，该值开始沿调用链返回；
- listener 可以等待下游结果，再修改并返回；
- 同一个 listener 只能调用一次 `next()`，第二次调用抛出明确错误；
- listener 失败时，`transform()` 失败；
- 分发前、进入每一层前和 listener 返回后检查 AbortSignal。

## 5. 错误报告

`Events` 可以接收一个 `EventListenerErrorHandler`。它只报告 `emit()` listener 的失败，因为事实 listener 没有权限中断运行。

错误报告集中在 `Events` 的私有方法中。该方法是终端错误边界：调用报告器时捕获报告器自身的异常并停止，不发布新的事件，也不增加错误队列。

这不是递归的错误处理机制，而是为了保持 `emit()` 的接口保证：观察者及其诊断代码都不能改变已经发生的事实。

## 6. 类型接口

`transform()` 在类型层使用同一个 `TValue` 作为 listener 输入、`next()` 输入和最终返回值。`EventContract` 的 transform 契约不再把输入和结果建模成两种可以不同的类型。

公共入口只导出使用或扩充事件机制需要知道的名称：

- `Events`；
- `EventMap`；
- `EventContract`；
- `EventMode`；
- `Unregister`；
- `EventDispatch`；
- `EventListenerErrorHandler`。

事件名筛选、输入提取、结果提取和 listener 推导类型属于实现细节，不从 `src/events/index.ts` 或根入口导出。

## 7. Agent 与 Harness 异常边界

### Stream 结束

每一轮模型 Stream 必须产生一个 `done` 或 `error` 终止块。Stream 在没有终止块时结束，Agent 抛出明确的协议错误，不发布带有 `undefined` message 的 `agent/turn-end`。

### 取消与系统错误

Harness 只把真正的取消错误归类为 `aborted`：AbortSignal 已取消，并且捕获到的错误是该 signal 的 reason 或 `AbortError`。

存储错误、代码错误和其他系统错误即使与取消同时发生，也归类为 `error`，发布 `harness/run-end` 后由 `prompt()` 重新抛出。

### readonly 消息

`convertToLlm` 接收 `readonly AgentMessage[]` 并返回 `readonly Message[]`。Agent、Harness 不使用类型断言把只读消息伪装成可变数组。

## 8. Events README

新增 `src/events/README.md`，按照读者第一次接触系统的顺序组织：

1. Event 与 `Events` 分别是什么；
2. 用 `on()` 与 `emit()` 完成最小使用；
3. `on()` 如何保存注册以及顺序如何确定；
4. `emit()` 调用谁、按照什么顺序调用；
5. `ask()` 询问谁、如何决定最终答案；
6. `transform()` 如何把值传给下一个 listener；
7. `EventMap` 如何在编译期约束以上操作；
8. Project、Session、Run 与一份 `Events` 实例的关系；
9. Agent、Harness、Coding Agent 和 UI 分别声明、分发或监听哪些事件；
10. listener 快照、错误、取消与取消注册；
11. 如何声明、分发和监听一个新事件；
12. 公共接口与依赖关系。

每个概念在第一次使用前先定义。文档不提及当前代码中不存在的机制。

## 9. 现有文档同步

`ai`、`agent`、`harness`、`coding-agent` README 和 `docs/architecture.md` 只描述当前实现：

- 链接到新的 Events README；
- 删除无效链接、残留词和失效测试名称；
- `emit()`、`ask()`、`transform()` 的描述与本规格一致；
- 不用历史迁移过程解释当前接口。

## 10. 验收

1. 相同函数的两次 `on()` 注册可以独立取消。
2. `emit()` 在 listener 和错误报告器都失败时仍继续调用后续 listener。
3. `transform()` 保留外层 listener 对下游结果的修改，并拒绝第二次 `next()`。
4. Transform 事件在类型层只有一个值类型。
5. 空 Stream 不发布非法 `agent/turn-end`，而是使 Run 失败。
6. abort 与存储失败同时发生时，存储失败不会被吞掉。
7. readonly 消息调用链不需要可变数组断言。
8. `src/events/README.md` 能让只理解基本 Agent 概念的读者说明四个方法的调用对象、顺序和返回规则。
9. 当前架构文档不存在无效链接或残留术语。
