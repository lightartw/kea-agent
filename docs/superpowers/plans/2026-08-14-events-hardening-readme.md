# Events Hardening and README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正统一事件机制中已经确认的运行时与类型错误，并用渐进式文档完整说明当前 Events、Agent、Harness、Coding Agent 和 UI 的协作关系。

**Architecture:** Project 创建唯一的 `Events` 实例，各层通过同一份 `EventMap` 声明事件契约。`emit()` 发布事实，`ask()` 向已注册 listener 请求一个答案，`transform()` 让同一种值经过 listener 链。Agent 负责一次 Run，Harness 负责 Session；二者只通过共享 Events 发布和处理当前层拥有的生命周期事件。

**Tech Stack:** TypeScript 7、Node.js 24、`node:test`、ES modules、Markdown。

## Global Constraints

- 先写能够稳定复现问题的失败测试，再修改实现。
- 不新增第二套事件分发机制，不新增错误事件或错误队列。
- 不用类型断言掩盖 readonly 边界。
- 用户文档只说明当前代码，不介绍已经删除的实现和迁移历史。
- 每个概念必须先定义再使用；方法说明必须写清调用对象、顺序、返回值和失败行为。
- 不创建新的领域类；只为独立 listener 注册增加内部记录对象。

---

## Task 1: 固化 Events 的注册与分发契约

**Files:**

- Modify: `tests/events/events.test.ts`
- Modify: `src/events/events.ts`
- Modify: `src/events/types.ts`
- Modify: `src/events/index.ts`
- Modify: `src/agent/events.ts`

- [ ] **Step 1: 为同一函数的独立注册增加失败测试**

在 `tests/events/events.test.ts` 增加：

```ts
test("the same listener can be registered and removed independently", async () => {
  const events = new Events();
  const calls: number[] = [];
  const listener = (input: { readonly value: number }) => {
    calls.push(input.value);
  };

  const unregisterFirst = events.on("test/fact", listener);
  events.on("test/fact", listener);
  unregisterFirst();
  unregisterFirst();

  await events.emit("test/fact", { value: 1 });
  assert.deepEqual(calls, [1]);
});
```

- [ ] **Step 2: 为错误报告器失败增加失败测试**

验证事实 listener 与错误报告器都抛错时，`emit()` 仍然调用后续 listener 并正常结束：

```ts
test("emit isolates listener error reporting failures", async () => {
  const calls: string[] = [];
  const events = new Events(() => {
    throw new Error("reporter failed");
  });
  events.on("test/fact", () => {
    calls.push("first");
    throw new Error("listener failed");
  });
  events.on("test/fact", () => { calls.push("second"); });

  await events.emit("test/fact", { value: 1 });
  assert.deepEqual(calls, ["first", "second"]);
});
```

- [ ] **Step 3: 为 transform 的完整调用链增加失败测试**

增加两个测试：

```ts
test("transform preserves outer post-processing", async () => {
  const events = new Events();
  events.on("test/value", async (value, next) => {
    const downstream = await next(value + 1);
    return downstream + 3;
  });
  events.on("test/value", (value) => value * 2);

  assert.equal(await events.transform("test/value", 1), 7);
});

test("transform rejects a second next call without rerunning downstream", async () => {
  const events = new Events();
  let downstreamCalls = 0;
  events.on("test/value", async (value, next) => {
    await next(value);
    return next(value);
  });
  events.on("test/value", (value) => {
    downstreamCalls += 1;
    return value;
  });

  await assert.rejects(events.transform("test/value", 1), /next.*once/i);
  assert.equal(downstreamCalls, 1);
});
```

- [ ] **Step 4: 运行 Events 测试并确认 RED**

Run:

```powershell
npm run build
node --test dist/tests/events/events.test.js
```

Expected: 新增的三个行为测试失败；已有测试仍能编译。

- [ ] **Step 5: 让每次 on() 保存独立注册**

在 `src/events/events.ts` 内部定义最小记录：

```ts
interface ListenerRegistration {
  readonly listener: AnyListener;
}
```

把存储改为 `Map<string, Set<ListenerRegistration>>`。每次 `on()` 创建新的记录对象；`unregister()` 删除该对象，而不是按函数身份删除。分发时仍复制 Set 得到快照，并从记录中取出 listener。

- [ ] **Step 6: 集中隔离 emit 的诊断失败**

增加一个私有终端方法：

```ts
#reportListenerError(error: unknown, dispatch: EventDispatch): void {
  try {
    this.#onListenerError?.(error, dispatch);
  } catch {
    // The diagnostic boundary cannot change fact delivery.
  }
}
```

`emit()` 捕获 listener 错误后只调用这个方法，然后继续循环。不要发布新的事件，也不要引入递归错误处理或错误队列。

- [ ] **Step 7: 修正 transform 的链式返回语义**

每层 listener 使用局部 `nextCalled`：

```ts
let nextCalled = false;
const next = (nextValue: EventResult<TName>): Promise<EventResult<TName>> => {
  if (nextCalled) {
    throw new Error(`transform listener for ${name} called next() more than once`);
  }
  nextCalled = true;
  return run(index + 1, nextValue);
};
const returned = await listener(value as never, next as never, signal as never);
signal?.throwIfAborted();
return returned as EventResult<TName>;
```

不要另外保存下游 Promise，也不要在调用过 `next()` 后丢弃外层 listener 的返回值。这样外层可以等待下游结果再处理，而第二次 `next()` 会在下游再次执行前失败。

- [ ] **Step 8: 让 transform 在类型层只有一个值类型**

把 `EventContract` 改为条件类型；transform 的 `result` 永远等于 `input`：

```ts
export type EventContract<
  TMode extends EventMode,
  TInput,
  TResult = void,
> = TMode extends "transform"
  ? { readonly mode: TMode; readonly input: TInput; readonly result: TInput }
  : { readonly mode: TMode; readonly input: TInput; readonly result: TResult };
```

同步将 `EventListener` 的 transform 分支收敛为一个 `TValue`：

```ts
ContractOf<TName> extends EventContract<"transform", infer TValue, unknown>
  ? (
      value: TValue,
      next: (value: TValue) => Promise<TValue>,
      signal?: AbortSignal,
    ) => TValue | Promise<TValue>
  : never;
```

把 `src/agent/events.ts` 和测试中的 transform 声明写成 `EventContract<"transform", TValue>`，不再传入重复的第三个类型。

- [ ] **Step 9: 收紧 Events 公共导出**

`src/events/index.ts` 只导出：

```ts
export { Events } from "./events.js";
export type {
  EventContract,
  EventDispatch,
  EventListenerErrorHandler,
  EventMap,
  EventMode,
  Unregister,
} from "./types.js";
```

`EventName`、`EventInput`、`EventResult`、模式筛选类型和 listener 推导类型继续留在 `types.ts` 供内部实现使用，但不从包入口暴露。

- [ ] **Step 10: 运行聚焦测试和类型检查**

Run:

```powershell
npm run build
node --test dist/tests/events/events.test.js dist/tests/agent/control-events.test.js
npm run typecheck
```

Expected: 全部通过；transform 的现有 Agent 声明无类型退化。

- [ ] **Step 11: 提交 Events 核心修复**

```powershell
git add src/events src/agent/events.ts tests/events/events.test.ts
git commit -m "fix: harden event dispatch semantics"
```

---

## Task 2: 修正 Agent Stream 与 readonly 边界

**Files:**

- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/harness/agent-harness.ts`
- Modify: `docs/architecture.md`

- [ ] **Step 1: 为没有终止块的 Stream 增加失败测试**

在 `tests/agent/agent-loop.test.ts` 增加一个空 async generator。订阅 `agent/turn-end`，然后断言：

```ts
await assert.rejects(
  runAgentLoop("hello", context, makeConfig({ events }), async function* () {}),
  /stream.*terminal|done.*error/i,
);
assert.equal(turnEnds, 0);
```

测试还应确认 user message 已按现有语义持久化，但不存在伪造的 assistant message。

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run:

```powershell
npm run build
node --test dist/tests/agent/agent-loop.test.js
```

Expected: 当前实现会发布包含 `undefined` message 的 `agent/turn-end` 或不会按预期拒绝。

- [ ] **Step 3: 在 Agent Loop 检查 Stream 协议终点**

完成一次 `for await` 后，在发布 `agent/turn-end` 前检查 `turnMessage`：

```ts
if (turnMessage === undefined) {
  throw new Error("Model stream ended without a done or error terminal chunk");
}
await config.events.emit("agent/turn-end", { ...config.run, message: turnMessage });
```

`error` 块继续沿用现有路径：先持久化消息，再发布 `agent/turn-end`，然后结束 Run。

- [ ] **Step 4: 把消息投影边界改为 readonly**

在 `src/agent/types.ts` 修改：

```ts
readonly convertToLlm: (
  messages: readonly AgentMessage[],
) => readonly Message[];
```

在 `src/agent/agent-loop.ts` 中让 `llmMessages` 使用 `readonly Message[]`，直接传入 `contextResult.messages`，删除 `as AgentMessage[]`。删除 user、done、error message 上不必要的 `as AgentMessage`；如果 AI 与 Agent 类型确实不兼容，应在类型定义层修正，而不是恢复断言。

在 `src/harness/agent-harness.ts` 中把 `convertToLlm` 写成 `messages => messages`，删除 `Message[]` 导入和断言。

- [ ] **Step 5: 同步架构接口示例**

将 `docs/architecture.md` 的 `AgentLoopConfig.convertToLlm` 签名同步为 readonly。这里只更新当前接口，不解释旧签名。

- [ ] **Step 6: 验证 Agent 和 Harness 相关测试**

Run:

```powershell
npm run build
node --test dist/tests/agent/agent-loop.test.js dist/tests/harness/agent-harness.test.js
npm run typecheck
```

Expected: 全部通过；`rg -n "as AgentMessage\[\]|as Message\[\]" src/agent src/harness` 无匹配。

- [ ] **Step 7: 提交 Agent 边界修复**

```powershell
git add src/agent/agent-loop.ts src/agent/types.ts src/harness/agent-harness.ts tests/agent/agent-loop.test.ts docs/architecture.md
git commit -m "fix: enforce agent stream boundaries"
```

---

## Task 3: 区分 Harness 取消与系统错误

**Files:**

- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `src/harness/agent-harness.ts`

- [ ] **Step 1: 为 abort 与持久化失败并发增加失败测试**

复用现有 Harness 测试工厂，覆盖以下时序：

1. `Session.appendMessage()` 在处理 user message 时调用 `harness.abort()`；
2. 同一次 `appendMessage()` 随后抛出 `Error("storage failed")`；
3. `prompt()` 必须拒绝该错误；
4. `harness/run-end` 必须只发布一次，`reason` 为 `error` 且 `errorMessage` 为 `storage failed`。

不要只测试普通存储失败；这个测试必须让 `abortRequested` 与存储失败同时成立，才能复现当前吞错行为。

- [ ] **Step 2: 运行 Harness 测试并确认 RED**

Run:

```powershell
npm run build
node --test dist/tests/harness/agent-harness.test.js
```

Expected: 当前 `catch` 因 `abortRequested === true` 忽略存储错误，把 Run 错误归类为 aborted 或让 `prompt()` 成功结束。

- [ ] **Step 3: 定义真实取消错误的最小判定函数**

在 `src/harness/agent-harness.ts` 增加普通私有文件函数，不创建类：

```ts
function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === "AbortError";
}
```

catch 块只忽略这个函数判定为 true 的错误：

```ts
} catch (error) {
  if (!isAbortFailure(error, abortController.signal)) {
    failure = error;
  }
}
```

`abortRequested` 仍用于表示用户确实发出了取消请求；它不再具有“所有并发错误都是取消”的含义。

- [ ] **Step 4: 验证取消与错误的全部边界**

Run:

```powershell
npm run build
node --test dist/tests/harness/agent-harness.test.js
```

Expected: 新增并发失败测试通过；既有 run-start 时取消、流式取消、普通失败、每个 run-start 对应一个 run-end 的测试也全部通过。

- [ ] **Step 5: 提交 Harness 错误分类修复**

```powershell
git add src/harness/agent-harness.ts tests/harness/agent-harness.test.ts
git commit -m "fix: preserve harness system failures on abort"
```

---

## Task 4: 编写渐进式 Events README

**Files:**

- Create: `src/events/README.md`

- [ ] **Step 1: 从 Event 与 Events 两个概念开始**

README 开头只建立两个概念：

- Event 是运行过程中需要分发的一项信息；它可能是已经发生的事实，也可能是行为提交前需要取得的答案或新值。
- `Events` 是运行时对象；listener 通过 `on()` 注册到它上面，代码通过 `emit()`、`ask()` 或 `transform()` 找到并调用这些 listener。

紧接着用一个 `on()` + `emit()` 的最小例子，让读者先看到“注册者”和“分发者”如何通过同一个 Events 实例相遇。

- [ ] **Step 2: 精确定义 on() 与注册顺序**

必须写清：

- `events.on(name, listener)` 把 listener 注册到“当前 `events` 实例的这个事件名”下；
- 后续对同一实例、同一事件名的分发才会调用它；
- 同一事件名的 listener 按 `on()` 调用先后排序；
- 同一个函数注册两次也是两次独立注册；
- 返回的函数只取消对应的一次注册；
- 分发开始后使用注册快照，本次过程中发生的注册变化下一次才生效。

- [ ] **Step 3: 精确定义三种分发方式**

按 `emit()`、`ask()`、`transform()` 的顺序讲解，每节都回答四个问题：调用谁、按什么顺序、返回什么、失败时发生什么。

`emit()` 的核心表述：

> `emit(name, input)` 按注册顺序调用当前 `Events` 实例中注册到该事件名的全部 listener。它等待前一个 listener 结束后再调用下一个；listener 的返回值被忽略。某个 listener 失败时，失败交给错误报告器，后续 listener 仍继续执行。

`ask()` 的核心表述：

> `ask(name, input, signal)` 按注册顺序询问当前 `Events` 实例中注册到该事件名的 listener。listener 返回 `undefined` 表示不回答；第一个非 `undefined` 值成为最终答案，之后的 listener 不再调用。如果全部 listener 都不回答，`ask()` 返回 `undefined`。

`transform()` 的核心表述：

> `transform(name, value, signal)` 把同一个类型的值交给第一个 listener。listener 调用 `next(newValue)` 时，`newValue` 进入下一个 listener；不调用 `next()` 就返回时，后续 listener 不再执行。外层 listener 可以等待下游结果，再修改并返回最终值。

用一个两层 transform 示例展示进入顺序与返回顺序；解释每个 listener 最多调用一次 `next()`。

- [ ] **Step 4: 再引入 EventMap 编译期契约**

读者理解运行时以后，再说明 `EventMap` 不保存 listener，也不负责分发；它只让 TypeScript 检查事件名、模式、输入和答案类型：

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

说明事件模块负责声明契约，拥有该行为的代码负责选择正确时点分发。

- [ ] **Step 5: 解释一份 Project Events 如何贯穿各层**

不用图。用短段落依次定义：

- Project 是 Coding Agent 管理的一组目录和 Session；它创建一份 `Events`。
- Session 是一段可恢复的对话历史。
- Run 是 Harness 对一次用户输入启动的一次 Agent 执行。
- 同一 Project 的 Harness、Agent Run、Coding Agent listener 和 UI 使用同一份 `Events`；事件用 `sessionId`、`runId`、`lane` 标识所属运行，UI 据此筛选自己展示的 Session。

随后列出职责：Agent 声明和分发 Agent Run 事实与控制事件；Harness 声明和分发 Session Run 边界；Coding Agent 注册 permission 等产品能力；UI 只订阅展示需要的事实。

- [ ] **Step 6: 补齐进阶行为与扩展步骤**

最后才说明：listener 快照、取消、错误报告、取消注册、公共导出和依赖方向。增加“新增事件”的完整步骤：在拥有该事件的层扩充 `EventMap`、在行为发生的准确位置分发、在组合层注册 listener、为顺序和错误语义写测试。

README 不出现已经删除机制的名字，不用“以前”“替换”“不再”等迁移句式。

- [ ] **Step 7: 自审 README 的渐进顺序**

逐节检查：每个术语是否在首次使用前定义；四个方法是否说明了调用对象和注册顺序；示例是否与当前类型签名一致；删除重复解释和只有设计者历史上下文才能理解的句子。

- [ ] **Step 8: 提交 Events README**

```powershell
git add src/events/README.md
git commit -m "docs: explain the events runtime progressively"
```

---

## Task 5: 同步包 README、架构文档和当前术语

**Files:**

- Modify: `src/ai/README.md`
- Modify: `src/agent/README.md`
- Modify: `src/harness/README.md`
- Modify: `src/coding-agent/README.md`
- Modify: `docs/architecture.md`
- Modify: `src/agent/tools/registry.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/coding-agent/tools/builtin/bash.test.ts`

- [ ] **Step 1: 修复 Agent README 的直接错误**

- 把 `turn。assistant` 改成正常中文句子；
- 把无效的 `[events/README 概念]` 改为可点击的 `../events/README.md` 链接；
- 更新 readonly `convertToLlm` 签名；
- 删除只解释旧机制不存在的句子，直接说明当前 Agent 如何使用共享 Events；
- 对 `emit()`、`ask()`、`transform()` 的描述链接到 Events README，避免在 Agent README 重复整套机制。

- [ ] **Step 2: 让其他包文档只解释本层职责**

- `ai/README.md`：说明 Stream 以 `done` 或 `error` 结束，以及完整消息与流块的边界；只在必要处链接 Events 文档。
- `harness/README.md`：从 Session 出发，说明 prompt 如何建立 run identity、发布 run-start、调用 Agent、发布 run-end；不要用被删除机制反衬当前设计。
- `coding-agent/README.md`：从 Project 出发，说明创建共享 Events、注册 permission listener、组装 tools 和 UI；明确 UI 通过 sessionId 过滤事实。
- `docs/architecture.md`：同步 `EventContract`、公共导出、readonly 和 Stream 终点；删除与当前代码不一致的接口片段。

- [ ] **Step 3: 清理源码注释和测试名称中的残留术语**

- `src/agent/tools/registry.ts` 的注释只说明 Registry 的验证与执行责任，不提旧控制机制；
- `tests/coding-agent/factory.test.ts` 将 “Hook registry” 改为 permission event listener；
- `tests/coding-agent/tools/builtin/bash.test.ts` 将 “Hook layer” 改为 permission listener 或 control event，测试行为不变。

- [ ] **Step 4: 扫描无效链接和历史上下文**

Run:

```powershell
rg -n "turn。assistant|events/README 概念|Hook registry|Hook layer|HookRegistry|Harness EventBus|liftAgentEvent|旧机制|替换了|不再使用" src docs/architecture.md tests
```

Expected: 无匹配。设计规格和实施计划可保留历史决策词汇，不纳入用户文档扫描范围。

- [ ] **Step 5: 验证 Markdown 中的本地链接目标**

人工核对五份包 README 与 `docs/architecture.md` 新增或修改的相对链接；所有链接必须指向存在的当前文件。

- [ ] **Step 6: 提交文档与术语同步**

```powershell
git add src/ai/README.md src/agent/README.md src/harness/README.md src/coding-agent/README.md docs/architecture.md src/agent/tools/registry.ts tests/coding-agent/factory.test.ts tests/coding-agent/tools/builtin/bash.test.ts
git commit -m "docs: align packages with the events contract"
```

---

## Task 6: 全量验收

**Files:**

- Verify only

- [ ] **Step 1: 运行完整测试**

```powershell
npm test
```

Expected: 所有测试通过。

- [ ] **Step 2: 运行独立类型检查**

```powershell
npm run typecheck
```

Expected: 退出码 0。

- [ ] **Step 3: 检查格式与残留断言**

```powershell
git diff --check
rg -n "as AgentMessage\[\]|as Message\[\]" src/agent src/harness
rg -n "turn。assistant|events/README 概念|Hook registry|Hook layer|HookRegistry|Harness EventBus|liftAgentEvent" src docs/architecture.md tests
```

Expected: `git diff --check` 无输出；两次 `rg` 无匹配。

- [ ] **Step 4: 对照规格逐项验收**

确认：

1. 相同函数的注册可独立取消；
2. 错误报告器失败不影响事实 listener；
3. transform 支持外层后处理且拒绝第二次 `next()`；
4. transform 类型只有一个值类型；
5. 空 Stream 明确失败且不发布非法 turn-end；
6. abort 不吞存储或系统错误；
7. readonly 消息边界无需数组断言；
8. Events README 清楚说明四个方法的调用对象、顺序和返回规则；
9. 所有用户文档只描述当前实现。

- [ ] **Step 5: 检查工作树和提交范围**

```powershell
git status --short
git log --oneline -6
```

Expected: 工作树干净；提交只包含本计划列出的代码、测试和文档。
