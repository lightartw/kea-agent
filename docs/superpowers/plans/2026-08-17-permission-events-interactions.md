# Permission、Events 与 Interactions 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Permission/Events/Interactions 设计实现为可独立测试的 core 与 coding-agent 模块：Tool Event 输入改为 `ToolCallEvent`/`ToolResultEvent`、Registry 顺序改为 lookup → validate → pre-execute → execute → post-execute、定义 UI 无关的 `Interactions.permission()` 端口、把 Permission 策略与内存规则做成用显式环境数据可测的 listener。

**Architecture:** 三个 Tool 拦截阶段的输入从裸 `AgentToolCall` 改为携带 Run 身份的事件类型；Registry 先 lookup/validate 再进入拦截阶段，使未知 Tool 和无效参数不触发 Permission。Permission 是 `tools/pre-execute` 上的 Coding Agent listener：hard deny > remembered allow > ask 三档策略，ask 时通过 `Interactions.permission()` 端口向外请求回答，`always` 回答先记录规则再放行。运行时按 Session 装配 cwd/trusted directories 的接线留给 Project 阶段，本计划只交付策略、规则与端口本身。

**Tech Stack:** TypeScript（Node 24、NodeNext ESM、`--verbatimModuleSyntax`、`--exactOptionalPropertyTypes`、`--noUncheckedIndexedAccess`）、`node:test`、TypeBox、`node:path` 平台路径语义、隔离 `tsc` 编译（不用全量构建）。

**Spec:** [docs/superpowers/specs/2026-08-17-permission-events-interactions-design.md](../specs/2026-08-17-permission-events-interactions-design.md)

## Global Constraints

- **不提交任何 commit。** 用户约束：直接修改，不要 commit。仓库当前同时带有未提交的 core 重构与用户 Project 工作，混在一起提交会污染历史。每个任务的完成标志 = 隔离编译通过 + 相关测试全部通过。
- **不触碰用户未提交的 Project 工作：** `src/coding-agent/project/`、`src/coding-agent/factory.ts`、`src/coding-agent/index.ts`、`docs/superpowers/{specs,plans}/2026-08-17-coding-agent-*.md`。这些文件当前已使全量构建失败，一律用隔离编译验证。
- **不改任何 AgentTool。** Tool 只实现操作，不感知 Permission、Interactions 或环境数据（spec §11「保持 Tool 不感知 Permission」）。
- **不把 cwd / trusted directories 加入通用 core Tool Event。** Permission 的环境数据由构造参数显式提供（spec §11「当前阶段不伪造缺失值」）。
- **目录包含关系必须用平台路径语义**（`node:path` 的 `resolve`/`relative`），禁止字符串 `startsWith()`（spec §7.2）。目录规则添加时做 `resolve()` 规范化；符号链接与真实路径解析属于 Project/path-policy 阶段，本计划不做。
- **命令规则是精确匹配**：command 文本与 cwd 任一不同就重新询问，不做文本规范化（spec §7.1）。
- **NodeNext ESM 导入必须带 `.js` 后缀；类型导入用 `import type`**（`--verbatimModuleSyntax`）。
- **`--exactOptionalPropertyTypes`：** 构造可选字段（如 `signal?`）用 conditional spread，不能直接赋 `undefined`。
- **EventMap augmentation 文件必须显式列入隔离编译命令**（`src/core/agent/tools/events.ts`、`src/core/agent/events.ts`），否则事件名不可赋值。
- **tsc 失败时不 emit，dist 中残留旧产物会让测试误通过。** 编译失败 = 测试结果无效；修复后必须重新编译再跑测试。
- **失败文本约定：** `AgentToolRegistry.error()` 统一加 `"Error: "` 前缀；Permission 的 deny reason 原样进入 Tool Result；无 reason 用 `Permission denied by user`（spec §5.2）。
- **`todo_write` 不需要新 Event 或 Interaction**（spec §10），本计划不为其添加任何东西。
- 测试/工具目录的路径在 `tests/coding-agent/tools/` 下已稳定；本计划新增 `tests/coding-agent/permission/`，删除 legacy `tests/coding-agent/events/`。

## File Map

**Create:**

| 文件 | 职责 |
| --- | --- |
| `src/coding-agent/interactions.ts` | `PermissionOperation`、`PermissionRequest`、`PermissionReply`、`Interactions` 端口、`NO_INTERACTIONS` 默认 fail-closed 实现 |
| `src/coding-agent/permission/bash-policy.ts` | 从 `src/coding-agent/tools/builtin/bash/bash-policy.ts` 原样迁移；唯一改动是导出 `BashDecision` 类型 |
| `src/coding-agent/permission/permission.ts` | `PermissionRules`（command/directory 内存规则）、`PermissionEnvironment`、`PermissionPolicy`、`Permission` 类、`createPermissionListener` 工厂 |
| `tests/coding-agent/interactions.test.ts` | Interactions 契约测试 |
| `tests/coding-agent/permission/bash-policy.test.ts` | 从 legacy `tests/coding-agent/events/permission.test.ts` 迁移三个策略测试 |
| `tests/coding-agent/permission/permission.test.ts` | spec §12 的 Permission/Interactions + Rules 验证矩阵 |
| `docs/superpowers/plans/2026-08-17-permission-events-interactions.md` | 本计划 |

**Rewrite:**

| 文件 | 改动 |
| --- | --- |
| `src/core/agent/tools/events.ts` | 新增 `ToolCallEvent`/`ToolResultEvent`；pre/execute 输入改为 `ToolCallEvent`，post 输入改为 `ToolResultEvent` |
| `src/core/agent/events.ts` | `agent/tool-call` → `EmitEvent<ToolCallEvent>`，`agent/tool-result` → `EmitEvent<ToolResultEvent>`，删掉重复匿名交叉类型 |
| `src/core/agent/tools/registry.ts` | `execute()` 内构造事件对象传入各拦截阶段；顺序改为 lookup → validate → pre-execute → execute → post-execute |
| `src/coding-agent/events/factory.ts` | 删除 `registerPermission` 的导入与调用；保留 `registerCodingEvents` 壳，注册留给 Project 阶段 |
| `src/core/agent/README.md` | §5 执行顺序与输入类型、§9 exports 增加 `ToolCallEvent`/`ToolResultEvent` |
| `docs/architecture.md` | §3「Agent：Tool 循环与事件控制」中三个拦截阶段的描述 |
| `src/coding-agent/README.md` | §6/§9/§10：Interactions 契约与 Permission 模块的描述 |

**Move:**

| 源 | 目标 |
| --- | --- |
| `src/coding-agent/tools/builtin/bash/bash-policy.ts` | `src/coding-agent/permission/bash-policy.ts` |
| legacy `tests/coding-agent/events/permission.test.ts` 中三个 Bash 策略测试（第 16-47 行） | `tests/coding-agent/permission/bash-policy.test.ts` |

**Delete:**

| 文件 | 原因 |
| --- | --- |
| `src/coding-agent/events/builtin/permission.ts` | legacy listener 签名 `(call, proceed, signal)` 与新 `ToolCallEvent` 载荷不兼容；被新 Permission 模块取代 |
| `tests/coding-agent/events/permission.test.ts` | 同上；策略测试迁出，listener 测试被新 permission.test.ts 取代 |

**明确不改：** `src/coding-agent/tools/` 下六个 Tool（`bash.ts` 等）——Tool 不感知 Permission（Global Constraints）。

## Isolated Verification

隔离编译模板（Windows Git Bash，路径用 `/`）：

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  <file1.ts> <file2.ts> ...
```

通过后运行测试：

```bash
node --test "dist/tests/..."
```

规则：每次改动后先重新编译（tsc 失败时 dist 是旧的，测试结果无效），再跑测试。每个任务给出各自的编译文件清单与测试命令。

---

### Task 1: Tool Event 载荷类型（ToolCallEvent / ToolResultEvent）

把三个 Tool 拦截阶段的输入从裸 call 改为带 Run 身份的事件类型，`agent/tool-call` 与 `agent/tool-result` 复用同一组类型。**本任务不改变 Registry 的阶段顺序**（顺序调整在 Task 2）。

**Files:**
- Rewrite: `src/core/agent/tools/events.ts`
- Rewrite: `src/core/agent/events.ts`
- Rewrite: `src/core/agent/tools/registry.ts`（只改载荷构造，阶段顺序保持 pre → lookup → validate → execute → post）
- Modify: `tests/agent/tools/registry.test.ts`、`tests/agent/control-events.test.ts`、`tests/agent/agent-loop.test.ts`（listener 签名改为 `(input, proceed)`）

**Interfaces:**
- Produces（Task 2、Task 4 依赖）:
  ```ts
  // src/core/agent/tools/events.ts
  export interface ToolCallEvent {
    readonly sessionId: string;
    readonly runId: string;
    readonly call: AgentToolCall;
  }
  export interface ToolResultEvent extends ToolCallEvent {
    readonly result: AgentToolResult;
  }
  // EventMap（augmentation 不变，只换输入类型）
  "tools/pre-execute": InterceptEvent<ToolCallEvent, PreToolDecision>;
  "tools/execute": InterceptEvent<ToolCallEvent, AgentToolResult>;
  "tools/post-execute": InterceptEvent<ToolResultEvent, AgentToolResult>;
  ```
- Consumes: 现有 `AgentToolCall`、`AgentToolResult`、`PreToolDecision`、`InterceptEvent`、`EmitEvent`。

- [x] **Step 1: 写失败测试——身份载荷测试 + 迁移 listener 签名**

在 `tests/agent/tools/registry.test.ts` 末尾追加：

```ts
test("Tool interception events carry Run identity, the call, and the result", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);
  const events = new Events();
  const seen: Array<{
    stage: string;
    sessionId: string;
    runId: string;
    call: AgentToolCall;
    result?: AgentToolResult;
  }> = [];
  events.on("tools/pre-execute", (input, proceed) => {
    seen.push({ stage: "pre", sessionId: input.sessionId, runId: input.runId, call: input.call });
    return proceed(input);
  });
  events.on("tools/execute", (input, proceed) => {
    seen.push({ stage: "execute", sessionId: input.sessionId, runId: input.runId, call: input.call });
    return proceed(input);
  });
  events.on("tools/post-execute", (input, proceed) => {
    seen.push({
      stage: "post",
      sessionId: input.sessionId,
      runId: input.runId,
      call: input.call,
      result: input.result,
    });
    return proceed(input);
  });

  const result = await registry.execute(echoCall(), contextFor(events));

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.deepEqual(seen.map((entry) => entry.stage), ["pre", "execute", "post"]);
  for (const entry of seen) {
    assert.equal(entry.sessionId, "session-1");
    assert.equal(entry.runId, "run-1");
    assert.equal(entry.call.name, "echo");
  }
  assert.deepEqual(seen[2].result, { content: "ok", isError: false });
});
```

同步迁移三个测试文件的 listener 签名（纯机械改动，逐个文件处理）：

- `tests/agent/tools/registry.test.ts` 第 104-115 行：`events.on("tools/pre-execute", (call, proceed) => ...)` 改为 `(input, proceed)`，内部用 `input.call`；`proceed({ ...call, arguments: ... })` 改为 `proceed({ ...input, call: { ...input.call, arguments: { value: "changed" } } })`。`tools/execute` listener 里的 `call.arguments` 改为 `input.call.arguments`。`tools/post-execute` 的 `(input, proceed)` 不变。
- `tests/agent/control-events.test.ts`：第 253 行 pre listener 的 `proceed({ ...input, arguments: ... })` 改为 `proceed({ ...input, call: { ...input.call, arguments: { value: "fixed" } } })`；第 276、307 行的 listener 签名本身（`(input, proceed)` / 无参）不变。
- `tests/agent/agent-loop.test.ts`：第 157-159 行三个 listener 改为 `(input, proceed) => { ...; return proceed(input); }`；第 352、363 行的无参 listener 不变。

- [x] **Step 2: 编译确认失败**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/events/events.ts src/core/events/types.ts \
  src/core/agent/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/core/agent/tools/registry.ts src/core/agent/tools/index.ts \
  src/core/agent/events.ts src/core/agent/agent-loop.ts \
  tests/fixtures/model-runtime.ts \
  tests/agent/tools/registry.test.ts tests/agent/control-events.test.ts tests/agent/agent-loop.test.ts
```

Expected: FAIL——`ToolCallEvent`/`ToolResultEvent` 不存在；`input.sessionId`、`input.call` 报属性不存在。

- [x] **Step 3: 实现三个文件**

`src/core/agent/tools/events.ts` 整体替换为：

```ts
import type { AgentToolCall, AgentToolResult } from "./types.js";
import type { InterceptEvent } from "../../events/types.js";

/** A Tool Call in one Run: Run identity plus the call itself. */
export interface ToolCallEvent {
  readonly sessionId: string;
  readonly runId: string;
  readonly call: AgentToolCall;
}

/** ToolCallEvent plus the execution result. */
export interface ToolResultEvent extends ToolCallEvent {
  readonly result: AgentToolResult;
}

export type PreToolDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason?: string };

declare module "../../events/types.js" {
  interface EventMap {
    "tools/pre-execute": InterceptEvent<ToolCallEvent, PreToolDecision>;

    "tools/execute": InterceptEvent<ToolCallEvent, AgentToolResult>;

    "tools/post-execute": InterceptEvent<ToolResultEvent, AgentToolResult>;
  }
}
```

`src/core/agent/events.ts`：删除 `import type { AgentToolCall, AgentToolResult } from "./tools/types.js";`，改为 `import type { ToolCallEvent, ToolResultEvent } from "./tools/events.js";`，并把两个载荷替换：

```ts
"agent/tool-call": EmitEvent<ToolCallEvent>;

"agent/tool-result": EmitEvent<ToolResultEvent>;
```

`src/core/agent/tools/registry.ts` 的 `execute()`：在 pre 阶段之前构造一次事件对象，三个拦截阶段都传它（**顺序本任务保持不变**：pre → lookup → validate → execute → post）：

```ts
async execute(
  call: AgentToolCall,
  executionContext: ToolExecutionContext,
): Promise<AgentToolResult<unknown>> {
  try {
    const event: ToolCallEvent = {
      sessionId: executionContext.sessionId,
      runId: executionContext.runId,
      call,
    };
    const preDecision = await executionContext.events.intercept(
      "tools/pre-execute",
      event,
      (): PreToolDecision => ({ kind: "allow" }),
      executionContext.signal,
    );
    if (preDecision.kind === "deny") {
      return this.error(preDecision.reason ?? "Tool execution denied");
    }

    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return this.error(`Unknown tool '${call.name}'`);
    }

    const validationError = tool.validate(call.arguments);
    if (validationError !== undefined) {
      return this.error(
        `Invalid arguments for tool '${call.name}': ${validationError}`,
      );
    }

    const result = await executionContext.events.intercept(
      "tools/execute",
      event,
      (input) =>
        runWithTimeout(
          this.timeout,
          (timeoutSignal) =>
            tool.execute(input.call.arguments, timeoutSignal),
          executionContext.signal,
        ),
      executionContext.signal,
    );

    return await executionContext.events.intercept(
      "tools/post-execute",
      { ...event, result },
      (input) => input.result,
      executionContext.signal,
    );
  } catch (error) {
    return this.error(errorMessage(error));
  }
}
```

顶部 `import type { PreToolDecision } from "./events.js";` 已有；补 `import type { ToolCallEvent } from "./events.js";`（`ToolResultEvent` 不需要——post 输入对象 `{ ...event, result }` 的结构由 `EventInput` 推导）。

- [x] **Step 4: 重新编译并运行测试**

编译命令同 Step 2。Expected: 无错误（`node_modules` 内 `typebox` 报错用 `--skipLibCheck` 排除）。

```bash
node --test "dist/tests/agent/tools/registry.test.js" \
  "dist/tests/agent/control-events.test.js" "dist/tests/agent/agent-loop.test.js"
```

Expected: PASS，共 29 个测试（registry 9 + 新 1，control-events 8，agent-loop 11）。

**完成标志：** 身份载荷测试通过；`agent/tool-call`/`agent/tool-result` 复用新类型（编译通过即为类型级验证）。

---

### Task 2: Registry 顺序与 pre-execute 只读语义

把 Registry 内部顺序改为 spec §3.3 的目标顺序 lookup → validate → pre-execute → execute → post-execute，使未知 Tool 与无效参数不触发 pre/Permission；验证 pre 是只读决策点。

**Files:**
- Rewrite: `src/core/agent/tools/registry.ts`（把 pre 块移到 lookup/validate 之后）
- Modify: `tests/agent/tools/registry.test.ts`（新增 3 个顺序/语义测试，扩展 1 个既有测试）
- Rewrite: `tests/agent/control-events.test.ts` 第 242-265 行的「pre-execute does not replace arguments before validation」测试（该语义被新顺序取代）
- Rewrite: `src/core/agent/README.md`（§5、§9）
- Rewrite: `docs/architecture.md`（§3 拦截阶段描述）

**Interfaces:**
- Consumes: Task 1 的 `ToolCallEvent`/`ToolResultEvent` 与 `execute()` 载荷。
- Produces: 无新类型；对外可见行为 = 未知 Tool/无效参数在 pre 之前失败；pre listener 的 `proceed(input)` 必须传同一 input，改 call 无效。

- [x] **Step 1: 写失败测试**

在 `tests/agent/tools/registry.test.ts` 追加：

```ts
test("unknown tools and invalid arguments never reach tools/pre-execute", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);
  const events = new Events();
  let preCalls = 0;
  events.on("tools/pre-execute", (input, proceed) => {
    preCalls += 1;
    return proceed(input);
  });

  const unknown = await registry.execute(
    echoCall({ name: "missing" }),
    contextFor(events),
  );
  const invalid = await registry.execute(
    echoCall({ arguments: {} }),
    contextFor(events),
  );

  assert.equal(unknown.isError, true);
  assert.equal(invalid.isError, true);
  assert.equal(preCalls, 0);
});

test("tools/pre-execute cannot replace the executed tool call", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  const other = new EchoTool("other");
  registry.register(tool);
  registry.register(other);
  const events = new Events();
  events.on("tools/pre-execute", (input, proceed) => proceed({
    ...input,
    call: { ...input.call, name: "other" },
  }));

  const result = await registry.execute(echoCall(), contextFor(events));

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.equal(tool.validations.length, 1);
  assert.equal(other.validations.length, 0);
});

test("tool interception listeners receive the Run signal", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());
  const events = new Events();
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  events.on("tools/pre-execute", (input, proceed, signal) => {
    received = signal;
    return proceed(input);
  });

  await registry.execute(
    echoCall(),
    contextFor(events, controller.signal),
  );

  assert.equal(received, controller.signal);
});
```

扩展既有测试「execute returns a pre-execute block result without running the tool」（第 127-141 行）：在 `events.on("tools/pre-execute", ...)` 之后追加 execute/post 计数 listener，断言它们不被调用：

```ts
  let executeCalls = 0;
  let postCalls = 0;
  events.on("tools/execute", (input, proceed) => {
    executeCalls += 1;
    return proceed(input);
  });
  events.on("tools/post-execute", (input, proceed) => {
    postCalls += 1;
    return proceed(input);
  });
```

并在末尾断言 `assert.equal(executeCalls, 0); assert.equal(postCalls, 0);`。

重写 `tests/agent/control-events.test.ts` 第 242-265 行的测试为（新顺序下无效参数先于 pre 失败）：

```ts
test("invalid arguments fail before tools/pre-execute runs", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "typed",
    arguments: { value: 1 },
  };
  const events = new Events();
  let preCalls = 0;
  events.on("tools/pre-execute", (input, proceed) => {
    preCalls += 1;
    return proceed(input);
  });
  const results: AgentToolResult[] = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId === "session-1") results.push(input.result);
  });

  await runAgentLoop(
    "run",
    memoryContext(tools, undefined, events),
    makeConfig(),
    streamForToolCall(call),
  );

  assert.equal(tool.ran, false);
  assert.equal(preCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.match(results[0].content, /Invalid arguments for tool 'typed'/);
});
```

- [x] **Step 2: 编译 + 运行，确认新测试失败**

编译命令同 Task 1 Step 2。然后：

```bash
node --test "dist/tests/agent/tools/registry.test.js" "dist/tests/agent/control-events.test.js"
```

Expected: FAIL 恰好 2 个新测试——「unknown tools and invalid arguments never reach tools/pre-execute」（旧顺序下 pre 先跑，`preCalls` 为 2）与「tools/pre-execute cannot replace the executed tool call」（旧顺序下 pre 改 call 后 lookup 的是 `other`，`tool.validations` 为 0）。其余（block 扩展、signal、control-events 重写）当前已通过，是回归护栏。

- [x] **Step 3: 调整 Registry 顺序**

`src/core/agent/tools/registry.ts` 的 `execute()`：把 lookup、validate 两块移到 pre 块之前，其余保持不变。最终形态：

```ts
async execute(
  call: AgentToolCall,
  executionContext: ToolExecutionContext,
): Promise<AgentToolResult<unknown>> {
  try {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return this.error(`Unknown tool '${call.name}'`);
    }

    const validationError = tool.validate(call.arguments);
    if (validationError !== undefined) {
      return this.error(
        `Invalid arguments for tool '${call.name}': ${validationError}`,
      );
    }

    const event: ToolCallEvent = {
      sessionId: executionContext.sessionId,
      runId: executionContext.runId,
      call,
    };
    const preDecision = await executionContext.events.intercept(
      "tools/pre-execute",
      event,
      (): PreToolDecision => ({ kind: "allow" }),
      executionContext.signal,
    );
    if (preDecision.kind === "deny") {
      return this.error(preDecision.reason ?? "Tool execution denied");
    }

    const result = await executionContext.events.intercept(
      "tools/execute",
      event,
      (input) =>
        runWithTimeout(
          this.timeout,
          (timeoutSignal) =>
            tool.execute(input.call.arguments, timeoutSignal),
          executionContext.signal,
        ),
      executionContext.signal,
    );

    return await executionContext.events.intercept(
      "tools/post-execute",
      { ...event, result },
      (input) => input.result,
      executionContext.signal,
    );
  } catch (error) {
    return this.error(errorMessage(error));
  }
}
```

- [x] **Step 4: 重新编译并运行全部受影响的测试**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/events/events.ts src/core/events/types.ts \
  src/core/agent/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/core/agent/tools/registry.ts src/core/agent/tools/index.ts \
  src/core/agent/events.ts src/core/agent/agent-loop.ts \
  tests/fixtures/model-runtime.ts \
  tests/agent/tools/registry.test.ts tests/agent/control-events.test.ts tests/agent/agent-loop.test.ts

node --test "dist/tests/agent/tools/registry.test.js" \
  "dist/tests/agent/control-events.test.js" "dist/tests/agent/agent-loop.test.js"
```

Expected: 全部 PASS（32 个：registry 13、control-events 8、agent-loop 11）。

- [x] **Step 5: 更新 core README 与 architecture**

`src/core/agent/README.md` §5 三个 bullet 整体替换为（顺序 + 输入类型 + pre 只读语义）：

```markdown
- **`tools/pre-execute`**：接收 `ToolCallEvent`（`sessionId`、`runId`、`call`），返回
  `PreToolDecision`。listener 调用 `proceed(input)` 以继续检查，或返回可选原因的 `deny` 以阻止
  执行。Registry 收到 `deny` 后统一生成错误 `AgentToolResult`。这是只读决策点：进入这一阶段前
  Registry 已经完成 lookup 和 TypeBox 校验，`proceed(input)` 必须传递同一个 input，listener
  不能借此替换实际执行的 Tool Call。
- **`tools/execute`**：以已经 lookup、校验过的 `ToolCallEvent` 作为输入，最终 handler 使用
  `input.call.arguments` 运行之前选中的 Tool。listener 可以包裹执行，也可以通过
  `proceed(changedInput)` 改变实际执行参数；Registry 不会在这一阶段重新 lookup 或验证。
- **`tools/post-execute`**：接收 `ToolResultEvent`（`ToolCallEvent` 加上 `result`），listener
  可以在结果写入 Session 前修改它。最终 handler 原样返回 `input.result`。
```

§5 开头「每个 Tool Call 在 `AgentToolRegistry.execute()` 内经过三个 `intercept()` 阶段」后补一句：`执行顺序为 lookup → validate → pre-execute → execute → post-execute；未知 Tool 或无效参数直接产生错误结果，不进入任何拦截阶段。`（§6 的事件顺序列表本身不变——事件发出的先后顺序没有变化。）

`src/core/agent/README.md` §9 exports 的 tools 段增加两个类型：

```markdown
- `AgentToolCall`, `AgentToolResult`, `ToolExecutionContext`, `PreToolDecision`,
  `ToolCallEvent`, `ToolResultEvent`
```

`docs/architecture.md` §3 事实事件段落（第 132-136 行）替换为：

```markdown
每个 Tool Call 在 `AgentToolRegistry.execute()` 内先做 lookup 和 TypeBox 校验，再经过三个拦截
阶段，由 `src/core/agent/tools/events.ts` 声明：`tools/pre-execute`、`tools/execute`、
`tools/post-execute`。pre-execute 接收 `ToolCallEvent` 并返回 `allow` 或可选原因的 `deny`；它是
只读决策点，listener 不能替换实际执行的 Tool Call。Registry 把拒绝统一转换成错误结果。execute
接收 `ToolCallEvent` 并运行 Tool 本体；post-execute 接收 `ToolResultEvent`，在结果写入 Session
前修改它。未知、无效、被阻止、已中止或失败的调用都会以恰好一个 `agent/tool-result` 结束。
```

**完成标志：** 新顺序测试通过；README §5/§9 与 architecture §3 与代码一致。

---

### Task 3: Interactions 契约

定义 UI 无关的 `Interactions.permission()` 端口与 fail-closed 默认实现。

**Files:**
- Create: `src/coding-agent/interactions.ts`
- Create: `tests/coding-agent/interactions.test.ts`

**Interfaces:**
- Produces（Task 4 依赖）——完整契约（verbatim 自 spec §5）：

```ts
export type PermissionOperation =
  | "read"
  | "write"
  | "edit"
  | "glob"
  | "execute";

export type PermissionRequest =
  | {
      readonly kind: "dangerous-command";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly command: string;
      readonly cwd: string;
      readonly reason: string;
    }
  | {
      readonly kind: "external-directory";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly operation: PermissionOperation;
      readonly targetPath: string;
      readonly directory: string;
      readonly reason: string;
    };

export type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };

export interface Interactions {
  permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply>;
}

/** Fail-closed default used when no external adapter exists. */
export const NO_INTERACTIONS: Interactions;
```

- Consumes: `AgentToolCall`（来自 `../core/agent/tools/types.js`）。

- [x] **Step 1: 写失败测试**

`tests/coding-agent/interactions.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_INTERACTIONS,
  type Interactions,
  type PermissionReply,
  type PermissionRequest,
} from "../../src/coding-agent/interactions.js";

test("NO_INTERACTIONS fails closed with the documented reason", async () => {
  const request: PermissionRequest = {
    kind: "dangerous-command",
    sessionId: "session-1",
    runId: "run-1",
    call: {
      type: "toolCall",
      id: "c1",
      name: "bash",
      arguments: { command: "rm file.txt" },
    },
    command: "rm file.txt",
    cwd: "/work",
    reason: "file deletion requires approval",
  };

  const reply = await NO_INTERACTIONS.permission(request);

  assert.deepEqual(reply, {
    kind: "deny",
    reason: "Permission request failed: interaction unavailable",
  });
});

test("the contract covers both request kinds and every reply kind", () => {
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "read_file",
    arguments: { path: "/tmp/x" },
  };
  const directoryRequest: PermissionRequest = {
    kind: "external-directory",
    sessionId: "session-1",
    runId: "run-1",
    call,
    operation: "read",
    targetPath: "/tmp/x",
    directory: "/tmp",
    reason: "outside the project",
  };
  const replies: PermissionReply[] = [
    { kind: "once" },
    { kind: "always" },
    { kind: "deny" },
    { kind: "deny", reason: "no" },
  ];

  assert.equal(directoryRequest.kind, "external-directory");
  assert.equal(directoryRequest.operation, "read");
  assert.deepEqual(replies.map((reply) => reply.kind), [
    "once",
    "always",
    "deny",
    "deny",
  ]);
});

test("Interactions is a two-way port whose shape is stable", async () => {
  const adapter: Interactions = {
    async permission(_request, signal): Promise<PermissionReply> {
      signal?.throwIfAborted();
      return { kind: "deny", reason: "adapter says no" };
    },
  };
  const reply = await adapter.permission({
    kind: "dangerous-command",
    sessionId: "s",
    runId: "r",
    call: { type: "toolCall", id: "1", name: "bash", arguments: {} },
    command: "git push",
    cwd: "/work",
    reason: "network write",
  });
  assert.deepEqual(reply, { kind: "deny", reason: "adapter says no" });
});
```

- [x] **Step 2: 编译确认失败**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/coding-agent/interactions.ts tests/coding-agent/interactions.test.ts
```

Expected: FAIL——`interactions.js` 模块不存在。

- [x] **Step 3: 实现 interactions.ts**

```ts
import type { AgentToolCall } from "../core/agent/tools/types.js";

export type PermissionOperation =
  | "read"
  | "write"
  | "edit"
  | "glob"
  | "execute";

export type PermissionRequest =
  | {
      readonly kind: "dangerous-command";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly command: string;
      readonly cwd: string;
      readonly reason: string;
    }
  | {
      readonly kind: "external-directory";
      readonly sessionId: string;
      readonly runId: string;
      readonly call: AgentToolCall;
      readonly operation: PermissionOperation;
      readonly targetPath: string;
      readonly directory: string;
      readonly reason: string;
    };

export type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };

/**
 * Port from Permission to an external decider (terminal, UI, or test).
 * The returned Promise ties one request to one reply; adapters needing a
 * request ID generate it in their own transport layer.
 */
export interface Interactions {
  permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply>;
}

/** Fail-closed default used when no external adapter exists. */
export const NO_INTERACTIONS: Interactions = Object.freeze({
  async permission(): Promise<PermissionReply> {
    return {
      kind: "deny",
      reason: "Permission request failed: interaction unavailable",
    };
  },
});
```

- [x] **Step 4: 重新编译并运行测试**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/coding-agent/interactions.ts tests/coding-agent/interactions.test.ts

node --test "dist/tests/coding-agent/interactions.test.js"
```

Expected: PASS（3 个测试）。

**完成标志：** 契约类型与默认实现就绪；没有其他主动交互需求（spec §5.3，不增加 `question()`）。

---

### Task 4: Permission 模块与 legacy 清理

把 Bash 策略迁移到 `permission/`，实现策略、规则与 listener 映射，删除 legacy Permission 装配。

**Files:**
- Move: `src/coding-agent/tools/builtin/bash/bash-policy.ts` → `src/coding-agent/permission/bash-policy.ts`（内容原样；唯一改动：`type BashDecision` 加 `export`）
- Create: `src/coding-agent/permission/permission.ts`
- Create: `tests/coding-agent/permission/bash-policy.test.ts`（迁移 legacy 三个策略测试，import 路径改新位置）
- Create: `tests/coding-agent/permission/permission.test.ts`
- Delete: `src/coding-agent/events/builtin/permission.ts`、`tests/coding-agent/events/permission.test.ts`
- Rewrite: `src/coding-agent/events/factory.ts`（去掉 `registerPermission`）
- Rewrite: `src/coding-agent/README.md`（§6/§9/§10）

**Interfaces:**
- Consumes: Task 1 的 `ToolCallEvent`/`PreToolDecision`、Task 3 的 `Interactions`/`PermissionRequest`/`PermissionReply`、迁移来的 `classifyBashCommand`。
- Produces:
  ```ts
  // src/coding-agent/permission/bash-policy.ts（迁移后）
  export type BashDecision =
    | { decision: "allow" }
    | { decision: "ask"; reason: string }
    | { decision: "deny"; reason: string };
  export function hardDeniedBashReason(command: string): string | undefined;
  export function classifyBashCommand(command: string): BashDecision;

  // src/coding-agent/permission/permission.ts
  export interface PermissionEnvironment { readonly cwd: string; }
  export type PermissionPolicy = (command: string) => BashDecision;
  export class PermissionRules {
    addCommand(command: string, cwd: string): void;
    matchesCommand(command: string, cwd: string): boolean;
    addDirectory(directory: string): void;
    matchesDirectory(targetPath: string): boolean;
  }
  export class Permission {
    readonly rules: PermissionRules;
    constructor(
      env: PermissionEnvironment,
      interactions: Interactions,
      policy?: PermissionPolicy,  // 默认 classifyBashCommand
    );
    async decide(input: ToolCallEvent, signal?: AbortSignal): Promise<PreToolDecision>;
  }
  export function createPermissionListener(permission: Permission): PermissionListener;
  // PermissionListener = tools/pre-execute 的 listener 签名：
  // (input: ToolCallEvent, proceed: (input: ToolCallEvent) => Promise<PreToolDecision>,
  //  signal?: AbortSignal) => Promise<PreToolDecision>
  ```
- 运行时装配（按 sessionId 提供 cwd、注册到共享 Events）不在本任务范围——spec §11 归 Project 阶段。

- [x] **Step 1: 迁移 Bash 策略测试**

创建 `tests/coding-agent/permission/bash-policy.test.ts`（import 改新路径，其余 verbatim）：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBashCommand,
  hardDeniedBashReason,
} from "../../../src/coding-agent/permission/bash-policy.js";

test("Bash policy hard-denies commands that must never reach UI", () => {
  for (const command of [
    "sudo true",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /dev/sda",
    "rm -rf /",
    "rm -r -f /",
  ]) {
    assert.equal(classifyBashCommand(command).decision, "deny", command);
    assert.ok(hardDeniedBashReason(command), command);
  }
});

test("Bash policy asks only for the teaching risk rules", () => {
  for (const command of [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]) {
    assert.equal(classifyBashCommand(command).decision, "ask", command);
    assert.equal(hardDeniedBashReason(command), undefined, command);
  }
});

test("Bash policy allows ordinary commands", () => {
  for (const command of ["pwd", "npm test", "git status"]) {
    assert.deepEqual(classifyBashCommand(command), { decision: "allow" });
  }
});
```

- [x] **Step 2: 编译确认失败**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/events/events.ts src/core/events/types.ts \
  src/core/agent/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/coding-agent/interactions.ts \
  tests/coding-agent/permission/bash-policy.test.ts
```

Expected: FAIL——`permission/bash-policy.js` 不存在。

- [x] **Step 3: 迁移 bash-policy.ts**

```bash
git mv src/coding-agent/tools/builtin/bash/bash-policy.ts src/coding-agent/permission/bash-policy.ts
```

用 `git mv` 保留历史。文件内容不动，只把 `type BashDecision =` 改为 `export type BashDecision =`。

- [x] **Step 4: 运行策略测试**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/coding-agent/permission/bash-policy.ts tests/coding-agent/permission/bash-policy.test.ts

node --test "dist/tests/coding-agent/permission/bash-policy.test.js"
```

Expected: PASS（3 个测试）——纯迁移，覆盖不变。

- [x] **Step 5: 写 Permission 失败测试**

`tests/coding-agent/permission/permission.test.ts`（spec §12 的 Permission/Interactions + Rules 矩阵；`/work` 等显式环境数据直接构造，不经过 Session）：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Type, type Static } from "typebox";

import { Events } from "../../../src/core/events/events.js";
import {
  AgentTool,
  type AgentToolResult,
  type AgentToolCall,
} from "../../../src/core/agent/tools/types.js";
import { AgentToolRegistry } from "../../../src/core/agent/tools/registry.js";
import type { ToolCallEvent } from "../../../src/core/agent/tools/events.js";
import {
  NO_INTERACTIONS,
  type Interactions,
  type PermissionReply,
  type PermissionRequest,
} from "../../../src/coding-agent/interactions.js";
import {
  Permission,
  PermissionRules,
  createPermissionListener,
  type PermissionPolicy,
} from "../../../src/coding-agent/permission/permission.js";

const parameters = Type.Object({ command: Type.String() });

class BashTool extends AgentTool<typeof parameters> {
  readonly calls: string[] = [];

  constructor() {
    super("bash", "Run a command.", parameters);
  }

  async execute(
    arguments_: Static<typeof parameters>,
  ): Promise<AgentToolResult> {
    this.calls.push(arguments_.command);
    return { content: "ok", isError: false };
  }
}

const ENV = { cwd: "/work" } as const;

function bashCall(command: string): AgentToolCall {
  return {
    type: "toolCall",
    id: "c1",
    name: "bash",
    arguments: { command },
  };
}

function bashEvent(command: string): ToolCallEvent {
  return {
    sessionId: "session-1",
    runId: "run-1",
    call: bashCall(command),
  };
}

class RecordingInteractions implements Interactions {
  readonly requests: PermissionRequest[] = [];

  constructor(private readonly replies: PermissionReply[]) {}

  async permission(request: PermissionRequest): Promise<PermissionReply> {
    this.requests.push(request);
    const reply = this.replies.shift();
    return reply ?? { kind: "once" };
  }
}

// ── Permission 策略与回答（spec §12）──

test("ordinary Bash commands proceed without an interaction", async () => {
  const interactions = new RecordingInteractions([]);
  const permission = new Permission(ENV, interactions);

  const decision = await permission.decide(bashEvent("echo hello"));

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interactions.requests.length, 0);
});

test("hard deny uses the policy reason and never asks", async () => {
  const interactions = new RecordingInteractions([]);
  const permission = new Permission(ENV, interactions);

  const decision = await permission.decide(bashEvent("sudo true"));

  assert.deepEqual(decision, { kind: "deny", reason: "sudo is not allowed" });
  assert.equal(interactions.requests.length, 0);
});

test("once allows the current call but records no rule", async () => {
  const interactions = new RecordingInteractions([{ kind: "once" }]);
  const permission = new Permission(ENV, interactions);

  const first = await permission.decide(bashEvent("rm file.txt"));

  assert.deepEqual(first, { kind: "allow" });
  assert.equal(permission.rules.matchesCommand("rm file.txt", "/work"), false);

  const second = await permission.decide(bashEvent("rm file.txt"));
  assert.equal(interactions.requests.length, 2);
  assert.deepEqual(second, { kind: "allow" });
});

test("always records the rule before allowing and skips later asks", async () => {
  const interactions = new RecordingInteractions([{ kind: "always" }]);
  const permission = new Permission(ENV, interactions);

  const first = await permission.decide(bashEvent("rm file.txt"));

  assert.deepEqual(first, { kind: "allow" });
  assert.equal(permission.rules.matchesCommand("rm file.txt", "/work"), true);

  const second = await permission.decide(bashEvent("rm file.txt"));
  assert.equal(interactions.requests.length, 1);
  assert.deepEqual(second, { kind: "allow" });
});

test("hard deny overrides a remembered allow", async () => {
  const policy: PermissionPolicy = (command) =>
    command === "rm x"
      ? { decision: "deny", reason: "rm is never allowed" }
      : { decision: "allow" };
  const interactions = new RecordingInteractions([]);
  const permission = new Permission(ENV, interactions, policy);
  permission.rules.addCommand("rm x", "/work");

  const decision = await permission.decide(bashEvent("rm x"));

  assert.deepEqual(decision, { kind: "deny", reason: "rm is never allowed" });
  assert.equal(interactions.requests.length, 0);
});

test("deny reason flows verbatim into the Tool Result", async () => {
  const registry = new AgentToolRegistry();
  const tool = new BashTool();
  registry.register(tool);
  const events = new Events();
  const interactions = new RecordingInteractions([
    { kind: "deny", reason: "不要删除这个文件，改为移动到回收站" },
  ]);
  events.on(
    "tools/pre-execute",
    createPermissionListener(new Permission(ENV, interactions)),
  );

  const result = await registry.execute(bashCall("rm file.txt"), {
    sessionId: "session-1",
    runId: "run-1",
    events,
  });

  assert.deepEqual(result, {
    content: "Error: 不要删除这个文件，改为移动到回收站",
    isError: true,
  });
  assert.equal(tool.calls.length, 0);
});

test("deny without a reason uses the default feedback", async () => {
  const registry = new AgentToolRegistry();
  const tool = new BashTool();
  registry.register(tool);
  const events = new Events();
  const interactions = new RecordingInteractions([{ kind: "deny" }]);
  events.on(
    "tools/pre-execute",
    createPermissionListener(new Permission(ENV, interactions)),
  );

  const result = await registry.execute(bashCall("rm file.txt"), {
    sessionId: "session-1",
    runId: "run-1",
    events,
  });

  assert.deepEqual(result, {
    content: "Error: Permission denied by user",
    isError: true,
  });
});

test("interaction failures and invalid replies close the door", async () => {
  const throwing: Interactions = {
    async permission(): Promise<PermissionReply> {
      throw new Error("adapter disconnected");
    },
  };
  const failed = await new Permission(ENV, throwing).decide(
    bashEvent("rm file.txt"),
  );
  assert.deepEqual(failed, {
    kind: "deny",
    reason: "Permission request failed: adapter disconnected",
  });

  const noAdapter = await new Permission(ENV, NO_INTERACTIONS).decide(
    bashEvent("rm file.txt"),
  );
  assert.deepEqual(noAdapter, {
    kind: "deny",
    reason: "Permission request failed: interaction unavailable",
  });

  const invalidReply: Interactions = {
    async permission(): Promise<PermissionReply> {
      return { kind: "maybe" } as unknown as PermissionReply;
    },
  };
  const invalid = await new Permission(ENV, invalidReply).decide(
    bashEvent("rm file.txt"),
  );
  assert.deepEqual(invalid, {
    kind: "deny",
    reason: "Permission request failed: invalid reply",
  });
});

test("a cancelled Run signal propagates instead of a user denial", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted");
  controller.abort(reason);
  const aborting: Interactions = {
    async permission(): Promise<PermissionReply> {
      throw reason;
    },
  };

  await assert.rejects(
    new Permission(ENV, aborting).decide(
      bashEvent("rm file.txt"),
      controller.signal,
    ),
    (error: unknown) => error === reason,
  );
});

test("non-Bash tools pass through without an interaction", async () => {
  const interactions = new RecordingInteractions([]);
  const permission = new Permission(ENV, interactions);

  const decision = await permission.decide({
    sessionId: "session-1",
    runId: "run-1",
    call: { type: "toolCall", id: "c1", name: "read_file", arguments: {} },
  });

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interactions.requests.length, 0);
});

test("allowed calls proceed through the listener chain", async () => {
  const registry = new AgentToolRegistry();
  const tool = new BashTool();
  registry.register(tool);
  const events = new Events();
  const interactions = new RecordingInteractions([]);
  events.on(
    "tools/pre-execute",
    createPermissionListener(new Permission(ENV, interactions)),
  );
  const chain: string[] = [];
  events.on("tools/pre-execute", (input, proceed) => {
    chain.push("after-permission");
    return proceed(input);
  });

  await registry.execute(bashCall("echo hi"), {
    sessionId: "session-1",
    runId: "run-1",
    events,
  });

  assert.deepEqual(chain, ["after-permission"]);
  assert.equal(tool.calls.length, 1);
});

test("denied calls stop the listener chain", async () => {
  const registry = new AgentToolRegistry();
  const tool = new BashTool();
  registry.register(tool);
  const events = new Events();
  const interactions = new RecordingInteractions([]);
  events.on(
    "tools/pre-execute",
    createPermissionListener(new Permission(ENV, interactions)),
  );
  const chain: string[] = [];
  events.on("tools/pre-execute", (input, proceed) => {
    chain.push("after-permission");
    return proceed(input);
  });

  const result = await registry.execute(bashCall("sudo true"), {
    sessionId: "session-1",
    runId: "run-1",
    events,
  });

  assert.deepEqual(chain, []);
  assert.equal(tool.calls.length, 0);
  assert.equal(result.isError, true);
});

// ── 规则（spec §12）──

test("command rules match only identical text and cwd", () => {
  const rules = new PermissionRules();
  rules.addCommand("rm file.txt", "/work");

  assert.equal(rules.matchesCommand("rm file.txt", "/work"), true);
  assert.equal(rules.matchesCommand("rm file.txt", "/other"), false);
  assert.equal(rules.matchesCommand("rm file.txt ", "/work"), false);
  assert.equal(rules.matchesCommand("rm file.txtx", "/work"), false);
});

test("directory rules cover the directory and its descendants only", () => {
  const rules = new PermissionRules();
  const base = join("work", "project");
  rules.addDirectory(base);

  assert.equal(rules.matchesDirectory(base), true);
  assert.equal(rules.matchesDirectory(join(base, "src", "main.ts")), true);
  assert.equal(rules.matchesDirectory(join("work", "projectx")), false);
  assert.equal(rules.matchesDirectory(join("work")), false);
  assert.equal(rules.matchesDirectory(join("work", "project", "..", "other")), false);
  assert.equal(rules.matchesDirectory(join("work", "other")), false);
});

test("a single directory rule serves all five file operations", () => {
  const rules = new PermissionRules();
  const base = join("work", "project");
  rules.addDirectory(base);

  const targets = {
    read: join(base, "a.ts"),
    write: join(base, "out", "b.ts"),
    edit: join(base, "c.ts"),
    glob: join(base, "src"),
    execute: join(base, ".bin", "tool"),
  } as const;
  for (const operation of ["read", "write", "edit", "glob", "execute"] as const) {
    assert.equal(rules.matchesDirectory(targets[operation]), true, operation);
  }
});
```

- [x] **Step 6: 编译确认失败**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/events/events.ts src/core/events/types.ts \
  src/core/agent/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/core/agent/tools/registry.ts src/core/agent/tools/index.ts \
  src/core/agent/events.ts src/core/agent/agent-loop.ts \
  src/coding-agent/interactions.ts \
  tests/fixtures/model-runtime.ts tests/agent/tools/registry.test.ts \
  tests/coding-agent/permission/permission.test.ts
```

Expected: FAIL——`permission/permission.js` 不存在。

- [x] **Step 7: 实现 permission.ts**

```ts
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { PreToolDecision, ToolCallEvent } from "../../core/agent/tools/events.js";
import type {
  Interactions,
  PermissionReply,
  PermissionRequest,
} from "../interactions.js";
import { classifyBashCommand, type BashDecision } from "./bash-policy.js";

/** Environment data supplied explicitly; Session wiring is Project-stage. */
export interface PermissionEnvironment {
  readonly cwd: string;
}

/** Classifies a Bash command into deny / ask / allow with a reason. */
export type PermissionPolicy = (command: string) => BashDecision;

/** In-memory authorization rules; lifecycle equals the Permission instance. */
export class PermissionRules {
  readonly #commands = new Set<string>();
  #directories: string[] = [];

  addCommand(command: string, cwd: string): void {
    this.#commands.add(`${cwd}\u0000${command}`);
  }

  matchesCommand(command: string, cwd: string): boolean {
    return this.#commands.has(`${cwd}\u0000${command}`);
  }

  /** Records the normalized absolute directory for an `always` reply. */
  addDirectory(directory: string): void {
    const normalized = resolve(directory);
    if (!this.#directories.includes(normalized)) {
      this.#directories.push(normalized);
    }
  }

  /**
   * Platform path containment via node:path: the directory itself and all
   * descendants. Never a string startsWith() prefix check (spec §7.2).
   * resolve() normalizes both sides; relative() supplies platform
   * separators and case behavior (win32) for free.
   */
  matchesDirectory(targetPath: string): boolean {
    const target = resolve(targetPath);
    return this.#directories.some((directory) => {
      const rest = relative(directory, target);
      if (rest === "") return true;
      if (isAbsolute(rest) || rest === "..") return false;
      return !rest.startsWith(`..${sep}`);
    });
  }
}
```

```ts
/** Strategy, rule state, and reply mapping for one Coding Agent runtime. */
export class Permission {
  readonly rules = new PermissionRules();

  constructor(
    private readonly env: PermissionEnvironment,
    private readonly interactions: Interactions,
    private readonly policy: PermissionPolicy = classifyBashCommand,
  ) {}

  /** Returns the PreToolDecision for one Tool Call. */
  async decide(
    input: ToolCallEvent,
    signal?: AbortSignal,
  ): Promise<PreToolDecision> {
    const { call } = input;
    if (call.name !== "bash") return { kind: "allow" };
    const command = call.arguments.command;
    if (typeof command !== "string") return { kind: "allow" };

    const classification = this.policy(command);
    if (classification.decision === "deny") {
      return { kind: "deny", reason: classification.reason };
    }
    if (this.rules.matchesCommand(command, this.env.cwd)) {
      return { kind: "allow" };
    }
    if (classification.decision === "allow") return { kind: "allow" };

    const request: PermissionRequest = {
      kind: "dangerous-command",
      sessionId: input.sessionId,
      runId: input.runId,
      call,
      command,
      cwd: this.env.cwd,
      reason: classification.reason,
    };

    let reply: PermissionReply;
    try {
      reply = await this.interactions.permission(request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        kind: "deny",
        reason: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    switch (reply.kind) {
      case "always":
        this.rules.addCommand(command, this.env.cwd);
        return { kind: "allow" };
      case "once":
        return { kind: "allow" };
      case "deny":
        return { kind: "deny", reason: reply.reason ?? "Permission denied by user" };
      default:
        return { kind: "deny", reason: "Permission request failed: invalid reply" };
    }
  }
}

/** tools/pre-execute listener signature. */
export type PermissionListener = (
  input: ToolCallEvent,
  proceed: (input: ToolCallEvent) => Promise<PreToolDecision>,
  signal?: AbortSignal,
) => Promise<PreToolDecision>;

/**
 * Binds a Permission to the listener contract. Allowed decisions call
 * `proceed(input)` with the same input so later listeners still run; denies
 * end the chain (spec §3.3: proceed must pass the same input).
 */
export function createPermissionListener(
  permission: Permission,
): PermissionListener {
  return async (input, proceed, signal) => {
    const decision = await permission.decide(input, signal);
    return decision.kind === "allow" ? proceed(input) : decision;
  };
}
```

- [x] **Step 8: 编译并运行 Permission 测试**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  src/core/events/events.ts src/core/events/types.ts \
  src/core/agent/types.ts src/core/agent/tools/types.ts src/core/agent/tools/events.ts \
  src/core/agent/tools/registry.ts src/core/agent/tools/index.ts \
  src/core/agent/events.ts src/core/agent/agent-loop.ts \
  src/coding-agent/interactions.ts \
  src/coding-agent/permission/bash-policy.ts src/coding-agent/permission/permission.ts \
  tests/fixtures/model-runtime.ts tests/agent/tools/registry.test.ts \
  tests/coding-agent/permission/permission.test.ts

node --test "dist/tests/coding-agent/permission/permission.test.js"
```

Expected: PASS（15 个测试）。

- [x] **Step 9: 删除 legacy 装配**

```bash
git rm src/coding-agent/events/builtin/permission.ts tests/coding-agent/events/permission.test.ts
```

`src/coding-agent/events/factory.ts` 整体替换为：

```ts
import { Events } from "../../core/events/events.js";
import type { CodingAgentInteractions } from "../ui/interactions.js";

/**
 * Coding listener registration entry point. Runtime wiring (per-session cwd,
 * trusted directories, registering the Permission listener) is assembled in
 * the Project stage — see
 * docs/superpowers/specs/2026-08-17-permission-events-interactions-design.md §11.
 */
export function registerCodingEvents(
  events: Events,
  interactions: CodingAgentInteractions,
): void {
  void events;
  void interactions;
}
```

- [x] **Step 10: 全量隔离验证**

```bash
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node \
  $(find src/core -name "*.ts") \
  src/coding-agent/interactions.ts $(find src/coding-agent/permission -name "*.ts") \
  src/coding-agent/events/factory.ts $(find src/coding-agent/tools -name "*.ts") \
  src/coding-agent/ui/interactions.ts \
  $(find tests/agent tests/events tests/utils tests/coding-agent/events tests/coding-agent/permission tests/coding-agent/tools -name "*.ts") \
  tests/coding-agent/interactions.test.ts tests/fixtures/model-runtime.ts

node --test "dist/tests/agent/**/*.test.js" "dist/tests/events/**/*.test.js" \
  "dist/tests/utils/**/*.test.js" "dist/tests/coding-agent/permission/**/*.test.js" \
  "dist/tests/coding-agent/tools/**/*.test.js" "dist/tests/coding-agent/interactions.test.js"
```

Expected: 编译零错误（`src/coding-agent/tools` 下全部内置 Tool 已与 Permission 解耦，随迁移文件一并验证）；全部测试 PASS。被排除的已知损坏文件：`src/coding-agent/factory.ts`、`src/coding-agent/index.ts`、`src/coding-agent/project/`（用户 Project 工作，Global Constraints 不触碰）。

- [x] **Step 11: 更新 coding-agent README**

`src/coding-agent/README.md`：

- §6 第 2 条「复用 Project 共享的 Events（Permission 等 coding listener 已注册其上）」改为「复用 Project 共享的 Events（coding listener 的运行时注册由 Project 阶段完成，见 §9）」。
- §9 首段替换为：

```markdown
Permission 是 `tools/pre-execute` 上的 Coding Agent listener，计算
hard deny > remembered allow > ask 三档策略。ask 时通过
`Interactions.permission()` 端口请求外部回答（`once` 不记录、`always` 先记录规则再放行、
`deny` 带可选原因）；没有外部 adapter 时使用 `NO_INTERACTIONS`，其 `permission()` 总是返回
带 `Permission request failed: interaction unavailable` 原因的 deny。策略与规则见
`src/coding-agent/permission/`，按 Session 提供 cwd 与 trusted directories 的运行时装配在
Project 阶段完成。
```

- §9 的 `CodingAgentInteractions.confirm` 代码块删除（该接口仍存在于 `ui/interactions.ts`，但不再承担 Permission 语义）；保留工具展示段落。
- §10 源码结构两行更新：删 `events/builtin/permission.ts` 行；新增：

```markdown
- `interactions.ts`：`Interactions` 端口与 `NO_INTERACTIONS` 默认实现；
- `permission/bash-policy.ts`、`permission/permission.ts`：Bash 命令分类策略与 Permission
  listener（策略、内存规则、reply 映射）；
```

**完成标志：** 新 Permission 测试 15 个 + 策略测试 3 个 + Interactions 测试 3 个全部通过；legacy 装配删除后全量隔离验证零错误；README 与代码一致。

---

## Completion Check

- [x] `tests/agent/tools/registry.test.js`：身份载荷、顺序、pre 只读、signal 传递、block 跳过 execute/post 全部通过（Task 1/2）。
- [x] `tests/agent/control-events.test.js`、`tests/agent/agent-loop.test.js`：事件顺序与错误归一化回归通过（Task 1/2）。
- [x] `tests/coding-agent/interactions.test.js`（Task 3）、`tests/coding-agent/permission/bash-policy.test.js`、`tests/coding-agent/permission/permission.test.js`（Task 4）全部通过。
- [x] spec §12 逐项核对：

| 验证要求 | 覆盖位置 |
| --- | --- |
| pre、execute、post 都收到正确的 sessionId、runId 和 call | Task 1 身份载荷测试 |
| post 额外收到 result | 同上（`seen[2].result`） |
| unknown Tool 和无效参数不触发 pre/Permission | Task 2 registry + control-events 测试 |
| pre deny 跳过 execute/post，并产生一个错误 Tool Result | Task 2 扩展 block 测试 + Task 4 deny 集成测试 |
| listener 收到当前 Run signal | Task 2 signal 测试 |
| pre listener 不能改变最终执行的 Tool Call | Task 2 cannot-replace 测试 |
| ordinary call 直接继续 | Task 4 ordinary 测试 |
| hard deny 不调用 Interaction | Task 4 hard-deny 测试 |
| once 执行但不记录规则 | Task 4 once 测试 |
| always 先记录规则再执行，后续匹配不重复询问 | Task 4 always 测试 |
| hard deny 覆盖 remembered allow | Task 4 override 测试 |
| deny reason 原样进入 Tool Result，无 reason 时使用默认反馈 | Task 4 两个 deny 集成测试 |
| Interaction 故障和无效 reply 关闭式失败 | Task 4 failure/invalid 测试 |
| abort 不报告成用户拒绝 | Task 4 abort 测试 |
| command 只有文本和 cwd 都相同时匹配 | Task 4 command-rule 测试 |
| directory 匹配自身和后代，不匹配相似前缀、父目录或兄弟目录 | Task 4 directory-rule 测试 |
| 平台大小写和分隔符行为由统一路径规范化实现决定 | `node:path` 的 `resolve`/`relative`（Task 4 实现，测试用 `join()` 平台无关） |
| remembered directory 对五种文件/执行操作使用同一规则 | Task 4 five-operations 测试 |

- [x] spec §11 当前阶段五项全部落地：事件输入调整（Task 1）、Registry 顺序（Task 2）、`Interactions.permission()`（Task 3）、Permission 策略/规则/映射脱离 UI 且显式环境数据可测（Task 4）、Tool 零改动（File Map 无工具文件）。
- [x] legacy 清理完成：`events/builtin/permission.ts`、`tests/coding-agent/events/permission.test.ts` 删除；`bash-policy.ts` 迁移到 `permission/`；`events/factory.ts` 不再注册旧 listener。
- [x] 文档同步：`src/core/agent/README.md`、`docs/architecture.md`、`src/coding-agent/README.md` 与代码一致。
- [x] 没有新增任何 commit（Global Constraints）。
