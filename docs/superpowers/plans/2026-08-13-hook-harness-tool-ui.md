# Hook, Harness, and Tool UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Hook 限定为 Agent Loop 控制通道，将 Harness subscribe 限定为事实观察通道，并以不依赖 UI 的结构化 Tool result 支撑可扩展的 CLI Tool 展示。

**Architecture:** `ai` 定义跨 Provider 的 `ToolResultMessage<TDetails>` 并由 Adapter 投影掉 `details`；`agent` 保持 Hook reducer、两阶段 Tool Registry 和唯一 Tool 终态；`agent/harness` 先持久化再通过 `subscribe()` 交付事实。`coding-agent` 只保留真正改变控制流的 permission Hook，并提供 Todo 领域投影；`ui` 负责 Hook 交互端口实现、Harness event 渲染和按 Tool 名称分派的 renderer。

**Tech Stack:** TypeScript 7, Node.js 24, Node test runner, TypeBox 1.3, ESM/NodeNext.

## Global Constraints

- 以 `docs/superpowers/specs/2026-08-13-hook-harness-tool-ui-design.md` 为唯一行为规格。
- Hook 输入统一使用 `Call`，不引入 `Invocation`。
- Hook 只处理尚未确定的候选动作；Event 只描述已确定的事实；`Harness.subscribe()` 是外部观察入口。
- `CodingHookUI` 只提供 `available`、`confirm()` 和 `notify()`，不按 Hook 数量增加专用方法。
- `details` 留在 Session/Agent/UI 内存消息中，不进入任何 Provider wire payload。
- 模型下一轮需要的 Tool 状态必须完整出现在 `content`；修改 `details` 的 Hook 必须同时返回完整 `content`。
- 每个最终 assistant tool call 必须恰好以 `tool_start -> tool_end` 或单个 `tool_rejected` 结束。
- Tool 和 `coding-agent` 不得导入 `src/ui`；所有具体 CLI UI 实现集中在 `src/ui`。
- 不增加 ExtensionHost、TUI Widget、RPC、dynamic tools、multimodal result、usage 或 terminate。
- 每个任务遵循 Red–Green–Refactor，通过定向测试后单独提交。

---

## File Structure

### Agent control and execution

- `src/agent/hooks/types.ts`: Hook Call/Result 契约，不包含观察者概念。
- `src/agent/hooks/registry.ts`: 按注册顺序聚合 Handler 结果，校验 `AfterToolCallResult`。
- `src/agent/tools/types.ts`: `AgentToolCall`、带 details 泛型的 `AgentToolResult` 和 `AgentTool`。
- `src/agent/tools/registry.ts`: lookup/validate 的 `prepare()` 与 timeout/execute 的 `execute()`。
- `src/agent/agent-loop.ts`: 唯一 Tool 调用时序与终态编排。
- `src/agent/types.ts`: 对外 Agent context/event 类型，包含 `tool_rejected`。

### Messages and persistence

- `src/ai/types.ts`: 带 `details` 的标准内部 Tool message。
- `src/ai/adapters/{anthropic,openai,gemini}.ts`: 只投影 Provider 需要的字段。
- `src/agent/harness/session/session.ts`: 读写时验证 JSON-safe details。

### Coding-agent domain

- `src/coding-agent/hooks/types.ts`: `CodingHookUI`、Hook 交互数据、Context 和 `NO_HOOK_UI`。
- `src/coding-agent/hooks/permission.ts`: 唯一默认控制 Hook。
- `src/coding-agent/tools/todo-write.ts`: 无状态 Todo Tool。
- `src/coding-agent/tools/todo-state.ts`: Todo details 验证、内容格式化和 Session 分支投影。

### UI

- `src/ui/frontend.ts`: readline 生命周期、Hook `confirm/notify`、Harness subscribe 装配。
- `src/ui/harness-renderer.ts`: 消费 `AgentEvent`，分派普通生命周期与 Tool 事件。
- `src/ui/tool-renderers.ts`: renderer 接口、Registry、通用 fallback 和错误隔离。
- `src/ui/todo-renderer.ts`: 只负责把已验证 `TodoDetails` 转成文本。

---

### Task 1: Establish Hook Call Contracts and the Generic Hook UI Port

**Files:**
- Modify: `src/agent/hooks/types.ts`
- Modify: `src/agent/hooks/registry.ts`
- Modify: `src/agent/hooks/index.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/hooks/types.ts`
- Modify: `src/coding-agent/hooks/permission.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/cli/frontend.ts`
- Modify: `tests/agent/hooks/registry.test.ts`
- Modify: `tests/coding-agent/hooks/permission.test.ts`
- Modify: `tests/cli/frontend.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: 现有 `AgentMessage`、`HookRegistry<TContext>.register/trigger`、Bash policy。
- Produces: `AgentHookCall`、五个 `*Call`、五个 `*Result`、`CodingHookUI`、`HookConfirmation`、`HookNotification`、`NO_HOOK_UI`。

- [ ] **Step 1: Rename the public Hook vocabulary in tests and add Result-invariant failures**

Update type-only imports to the exact target names and add these registry cases:

```ts
test("tool_result carries details through accumulated results", async () => {
  const hooks = registry();
  hooks.register("tool_result", () => ({
    content: "normalized",
    details: { count: 1 },
  }));
  hooks.register("tool_result", (call) => {
    assert.deepEqual(call.details, { count: 1 });
    return { isError: true };
  });

  assert.deepEqual(await hooks.trigger({
    type: "tool_result",
    toolCallId: "c1",
    toolName: "todo_write",
    input: {},
    content: "raw",
    details: { count: 0 },
    isError: false,
  }), {
    content: "normalized",
    details: { count: 1 },
    isError: true,
  });
});

test("tool_result rejects details without string content", async () => {
  const hooks = registry();
  hooks.register("tool_result", (() => ({ details: { count: 1 } })) as never);
  await assert.rejects(
    hooks.trigger({
      type: "tool_result",
      toolCallId: "c1",
      toolName: "todo_write",
      input: {},
      content: "raw",
      isError: false,
    }),
    /details.*content/,
  );
});
```

In permission/frontend tests replace `PermissionRequest` with:

```ts
const confirmation: HookConfirmation = {
  source: "permission",
  title: "Allow Bash command?",
  message: "file deletion requires approval\nTool: bash({\"command\":\"rm file.txt\"})",
};
```

- [ ] **Step 2: Run the focused tests and verify the old contracts fail**

Run:

```powershell
npm run build
```

Expected: TypeScript errors for missing `BeforeToolCall`、`AfterToolCallResult`、`HookConfirmation` and the old permission request signature.

- [ ] **Step 3: Define the exact Hook Call and result types**

Replace the event-named Hook inputs with:

```ts
export interface HookCall<TType extends string> {
  readonly type: TType;
}

export interface BeforeUserPromptCall extends HookCall<"user_prompt"> {
  readonly prompt: string;
}

export interface TransformContextCall extends HookCall<"context"> {
  readonly messages: readonly AgentMessage[];
}

export interface BeforeToolCall extends HookCall<"tool_call"> {
  readonly toolCallId: string;
  readonly toolName: string;
  input: Record<string, unknown>;
}

export interface AfterToolCall extends HookCall<"tool_result"> {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly details?: unknown;
  readonly isError: boolean;
}

export interface BeforeStopCall extends HookCall<"stop"> {
  readonly messages: readonly AgentMessage[];
}

export interface BeforeUserPromptResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface TransformContextResult {
  readonly messages?: AgentMessage[];
}

export interface BeforeToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

export type AfterToolCallResult =
  | { readonly content?: string; readonly details?: never; readonly isError?: boolean }
  | { readonly content: string; readonly details: unknown; readonly isError?: boolean };

export interface BeforeStopResult {
  readonly continueWith?: AgentMessage;
}

export type AgentHookCall =
  | BeforeUserPromptCall
  | TransformContextCall
  | BeforeToolCall
  | AfterToolCall
  | BeforeStopCall;
```

Update `ResultOf<TCall>`、`HookHandler`、`AgentHookTrigger` and Registry reducer names to use these types. Keep `HookListener/registerListener` temporarily; Task 7 removes them only after subscribe consumers exist.

- [ ] **Step 4: Enforce the AfterToolCall runtime invariant in the Registry**

Before applying each `tool_result` Handler output, validate it with:

```ts
function assertAfterToolCallResult(value: unknown): asserts value is AfterToolCallResult {
  if (typeof value !== "object" || value === null) return;
  if (!Object.hasOwn(value, "details")) return;
  if (!Object.hasOwn(value, "content") ||
    typeof (value as { content?: unknown }).content !== "string") {
    throw new TypeError("AfterToolCallResult details requires string content");
  }
}
```

The reducer must carry `content`、`details`、`isError` forward separately and construct the next `AfterToolCall` from the accumulated values.

- [ ] **Step 5: Move the Hook UI contract to the Hook boundary and generalize permission**

Define in `src/coding-agent/hooks/types.ts`:

```ts
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

export interface CodingHookUI {
  readonly available: boolean;
  confirm(confirmation: HookConfirmation, signal?: AbortSignal): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}

export interface CodingHookContext {
  readonly cwd: string;
  readonly ui: CodingHookUI;
}

export const NO_HOOK_UI: CodingHookUI = Object.freeze({
  available: false,
  async confirm() { return false; },
  notify() { return undefined; },
});
```

Make `src/coding-agent/types.ts` import/re-export these Hook-owned types and keep `CreateHarnessConfig.ui?: CodingHookUI`. Permission must call:

```ts
await context.ui.confirm({
  source: "permission",
  title: "Allow Bash command?",
  message: `${decision.reason}\nTool: bash(${JSON.stringify(event.input)})`,
}, signal);
```

Keep hard deny away from UI, no UI fail-closed, false as normal block, and thrown UI errors as `permission confirmation failed`.

- [ ] **Step 6: Update current call sites and exports without changing execution order yet**

Update `agent-loop.ts`、permission imports、CLI confirm prompt and root smoke imports. Change the coding-agent factory fallback import from `NO_UI` to `NO_HOOK_UI`. The CLI question must use:

```ts
`\n⚠ ${confirmation.title}\n   ${confirmation.message}\n   Allow? [y/N] `
```

Do not move `src/cli` in this task. Do not remove passive Hook modules in this task.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
npm run build
node --test dist/tests/agent/hooks/registry.test.js dist/tests/coding-agent/hooks/permission.test.js dist/tests/cli/frontend.test.js dist/tests/import-smoke.test.js
npm test
```

Expected: all commands pass; existing Agent Loop behavior remains unchanged.

- [ ] **Step 8: Commit**

```powershell
git add src/agent/hooks src/agent/agent-loop.ts src/coding-agent src/cli/frontend.ts tests/agent/hooks tests/coding-agent/hooks tests/cli tests/import-smoke.test.ts
git commit -m "refactor: define hook call contracts"
```

---

### Task 2: Add Structured Tool Result Details Without Leaking Them to Providers

**Files:**
- Modify: `src/ai/types.ts`
- Modify: `src/agent/tools/types.ts`
- Modify: `src/agent/harness/session/session.ts`
- Modify: `tests/ai/fixtures.ts`
- Create: `tests/ai/tool-result-details.test.ts`
- Modify: `tests/coding-agent/session.test.ts`

**Interfaces:**
- Consumes: ai `Message`, Agent `AgentMessage = Message`, existing Provider adapters and Session JSONL format.
- Produces: `ToolResultMessage<TDetails = unknown>`, `AgentToolResult<TDetails = unknown>`, `AgentTool<TParameters, TDetails>` and JSON-safe Session round trips.

- [ ] **Step 1: Add type and Session tests for details**

Add a tool fixture containing a marker that must remain internal:

```ts
export const detailedToolResult: Message = {
  role: "tool",
  toolCallId: "call-1",
  name: "todo_write",
  content: "Current tasks:\n1. [pending] test",
  details: { privateMarker: "must-not-reach-provider" },
  isError: false,
};
```

Add Session cases that:

```ts
await session.appendMessage(detailedToolResult);
assert.deepEqual(session.buildContext().messages.at(-1), detailedToolResult);

await assert.rejects(
  session.appendMessage({
    ...detailedToolResult,
    details: { invalid: BigInt(1) },
  }),
  /invalid message/,
);
```

Also persist/open a JSONL session with nested arrays, booleans and null in details, and open a legacy tool message without `details`.

- [ ] **Step 2: Add adapter projection tests that capture SDK requests**

For each adapter, replace its private SDK value in the test with a recording fake using `Object.defineProperty()`, exhaust `adapter.stream()`, and assert:

```ts
const wire = JSON.stringify(capturedRequest);
assert.match(wire, /Current tasks/);
assert.doesNotMatch(wire, /must-not-reach-provider/);
assert.doesNotMatch(wire, /privateMarker/);
```

Use empty async iterables for OpenAI and Gemini. For Anthropic, make `messages.create()` return an empty async iterable. The assertion must inspect the actual request passed to the SDK method, not a duplicate conversion function in the test.

- [ ] **Step 3: Run tests and verify details are not yet accepted by the types**

Run:

```powershell
npm run build
```

Expected: TypeScript rejects the `details` property and generic `AgentToolResult<TDetails>` usage.

- [ ] **Step 4: Add details to the ai and agent data models**

Implement:

```ts
export interface ToolResultMessage<TDetails = unknown> {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly details?: TDetails;
  readonly isError?: boolean;
}

export interface AgentToolResult<TDetails = unknown> {
  readonly content: string;
  readonly details?: TDetails;
  readonly isError: boolean;
}

export abstract class AgentTool<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> implements Tool {
  abstract execute(
    arguments_: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}
```

Do not introduce `AgentToolResultMessage`; `AgentMessage` remains the alias of ai `Message`.

- [ ] **Step 5: Validate JSON-safe details at the Session boundary**

Add a recursive validator that accepts only JSON primitives, arrays and plain records:

```ts
function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}
```

The tool-message branch of `isAgentMessage()` must accept missing details and require present details to satisfy `isJsonValue()`.

- [ ] **Step 6: Verify Provider adapters omit details**

The current three adapter projections already construct Provider objects field-by-field. Keep that approach; do not spread a `ToolResultMessage` into SDK input. Adjust only code needed for the new tests, and ensure each projection reads `content`、tool call ID and name without reading `details`.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
npm run build
node --test dist/tests/ai/tool-result-details.test.js dist/tests/coding-agent/session.test.js
npm test
```

Expected: JSON-safe details round-trip; invalid values fail before Session mutation; all captured Provider payloads omit the marker.

- [ ] **Step 8: Commit**

```powershell
git add src/ai/types.ts src/agent/tools/types.ts src/agent/harness/session/session.ts tests/ai tests/coding-agent/session.test.ts
git commit -m "feat: add structured tool result details"
```

---

### Task 3: Split Tool Lookup and Validation From Execution

**Files:**
- Modify: `src/agent/tools/registry.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `src/utils/timeout.ts`
- Modify: `tests/agent/tools/registry.test.ts`
- Modify: `tests/utils/timeout.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: `AgentToolCall`, `AgentToolResult<unknown>`, `AgentTool.validate()` and `runWithTimeout()`.
- Produces: module-local `ToolPreparation`, module-local `PreparedAgentToolCall`, public `AgentToolRegistry.prepare(call)` and `execute(prepared, signal?)`.

- [ ] **Step 1: Replace one-step Registry tests with two-phase behavior tests**

Add exact assertions for all preparation states:

```ts
const ready = registry.prepare({
  type: "toolCall", id: "1", name: "echo", arguments: { value: "ok" },
});
assert.equal(ready.kind, "ready");
if (ready.kind === "ready") {
  assert.deepEqual(await registry.execute(ready.prepared), {
    content: "ok",
    isError: false,
  });
}

assert.deepEqual(
  registry.prepare({ type: "toolCall", id: "2", name: "missing", arguments: {} }),
  {
    kind: "rejected",
    reason: "unknown",
    result: { content: "Error: Unknown tool 'missing'", isError: true },
  },
);

const invalid = registry.prepare({
  type: "toolCall", id: "3", name: "echo", arguments: {},
});
assert.equal(invalid.kind, "rejected");
if (invalid.kind === "rejected") assert.equal(invalid.reason, "invalid");
```

Use a validating tool with a counter to prove `execute(prepared)` does not invoke `validate()` again. Add a caller-abort test for `runWithTimeout()` and a Tool execution test proving the exact caller abort reaches the Tool in combination with the Registry timeout.

- [ ] **Step 2: Run the Registry test and verify `prepare()` is missing**

Run:

```powershell
npm run build
```

Expected: TypeScript reports that `prepare` does not exist and `execute` expects an `AgentToolCall`.

- [ ] **Step 3: Implement the internal prepared value and discriminated result**

Keep these declarations in `src/agent/tools/registry.ts` and do not export them from `src/agent/tools/index.ts`:

```ts
interface PreparedAgentToolCall {
  readonly call: AgentToolCall;
  readonly tool: AgentTool;
}

type ToolPreparation =
  | { readonly kind: "ready"; readonly prepared: PreparedAgentToolCall }
  | {
      readonly kind: "rejected";
      readonly reason: "unknown" | "invalid";
      readonly result: AgentToolResult<unknown>;
    };
```

Implement:

```ts
prepare(call: AgentToolCall): ToolPreparation {
  const tool = this.tools.get(call.name);
  if (tool === undefined) {
    return { kind: "rejected", reason: "unknown", result: this.error(`Unknown tool '${call.name}'`) };
  }
  const validationError = tool.validate(call.arguments);
  if (validationError !== undefined) {
    return {
      kind: "rejected",
      reason: "invalid",
      result: this.error(`Invalid arguments for tool '${call.name}': ${validationError}`),
    };
  }
  return { kind: "ready", prepared: { call, tool } };
}

async execute(
  prepared: PreparedAgentToolCall,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  try {
    return await runWithTimeout(this.timeout, (timeoutSignal) =>
      prepared.tool.execute(prepared.call.arguments, timeoutSignal), signal);
  } catch (error) {
    return this.error(error instanceof Error ? error.message : String(error));
  }
}
```

Extend `runWithTimeout()` with an optional caller signal. Race the operation against an abort promise attached to `AbortSignal.any([controller.signal, callerSignal])`, pass that merged signal into the operation, and remove the listener in `finally`. This is required so an externally aborted, already-started Tool still terminates as `tool_end` with an error result.

- [ ] **Step 4: Adapt Agent Loop mechanically without changing event semantics**

At the old execution point, call `prepare(call)` and either use its rejection result or `await execute(prepared)`. Leave the existing `tool_start` placement for Task 4; this step only changes the Registry contract while keeping the suite green.

- [ ] **Step 5: Make the tools barrel explicit**

Replace `export *` with named exports so the internal prepared value cannot become a root API accidentally:

```ts
export { AgentToolRegistry } from "./registry.js";
export { AgentTool } from "./types.js";
export type { AgentToolCall, AgentToolResult } from "./types.js";
```

- [ ] **Step 6: Run focused and full tests**

Run:

```powershell
npm run build
node --test dist/tests/agent/tools/registry.test.js dist/tests/agent/agent-loop.test.js dist/tests/import-smoke.test.js
npm test
```

Expected: lookup and validation happen in `prepare()`; timeout and thrown execution errors are normalized in `execute()`; no existing event expectation changes yet.

- [ ] **Step 7: Commit**

```powershell
git add src/agent/tools src/agent/agent-loop.ts src/utils/timeout.ts tests/agent/tools tests/utils/timeout.test.ts tests/import-smoke.test.ts
git commit -m "refactor: prepare tool calls before execution"
```

---

### Task 4: Make Every Tool Call Produce One Correct Terminal Lifecycle

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/agent-loop.ts`
- Modify: `tests/agent/agent-loop.test.ts`
- Modify: `tests/coding-agent/agent-harness.test.ts`

**Interfaces:**
- Consumes: `BeforeToolCall`、`AfterToolCall`、`AgentToolRegistry.prepare/execute`、Harness persistence-before-publish behavior.
- Produces: `ToolRejectedReason`, `ToolRejectedEvent`, final-argument `tool_start/tool_end`, complete synthetic ToolResult messages and exactly-one-terminal-event behavior.

- [ ] **Step 1: Add successful execution ordering and AfterToolCallResult details tests**

Record an ordered trace and assert:

```ts
assert.deepEqual(trace, [
  "hook:before",
  "validate:changed",
  "event:tool_start:changed",
  "execute:changed",
  "hook:after:changed",
  "event:tool_end:changed",
]);
```

Add an AfterToolCall handler returning:

```ts
{
  content: "Current tasks:\n1. [completed] tested",
  details: { todos: [{ content: "tested", status: "completed" }] },
}
```

Assert the exact final result is equal in the `tool_end` event, the in-memory tool message and the next `StreamFn` context. Assert `tool_rejected.call.arguments` remains the original model object when a Hook mutates its working input.

- [ ] **Step 2: Add one-terminal-event tests for every non-execution path**

Use a table for `blocked`、`invalid`、`unknown` and assert each case has:

```ts
assert.equal(events.filter((event) => event.type === "tool_start").length, 0);
assert.equal(events.filter((event) => event.type === "tool_end").length, 0);
assert.equal(events.filter((event) => event.type === "tool_rejected").length, 1);
assert.equal(messages.filter((message) =>
  message.role === "tool" && message.toolCallId === callId
).length, 1);
assert.equal(afterToolCallCount, 0);
```

Add a batch with three calls. Abort while the first real execution is active; make it return `{ content: "Error: aborted", isError: true }`. Assert the first call has `tool_start -> tool_end`, and the other two each have one `tool_rejected` with reason `aborted` plus one synthetic tool message.

Add a permission-confirm test where confirm returns false after the run signal aborts; assert reason `aborted`, not `blocked`.

- [ ] **Step 3: Add Harness ordering assertions**

In the Harness subscriber, for `tool_end` and `tool_rejected`, read `session.buildContext()` and assert the matching tool message already exists and contains the same content/details as the event result.

- [ ] **Step 4: Run focused tests and confirm current lifecycle failures**

Run:

```powershell
npm run build
node --test dist/tests/agent/agent-loop.test.js dist/tests/coding-agent/agent-harness.test.js
```

Expected: failures show `tool_start` occurring before the Hook, missing `tool_rejected`, missing details propagation, and pending aborted calls being dropped.

- [ ] **Step 5: Add the rejected event types**

Define and include in `AgentEvent`:

```ts
export type ToolRejectedReason = "blocked" | "invalid" | "unknown" | "aborted";

export interface ToolRejectedEvent {
  readonly type: "tool_rejected";
  readonly call: AgentToolCall;
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult<unknown>;
  readonly reason: ToolRejectedReason;
}
```

Keep `tool_start` and `tool_end` carrying the effective `AgentToolCall`; `tool_rejected.call` always carries the untouched original model call.

- [ ] **Step 6: Implement the Loop sequence around immutable original calls**

After `turn_end`, do not return early merely because the signal is aborted when the final assistant message contains Tool calls; enter the batch and synthesize their terminal results. For each original call:

```ts
const workingInput = structuredClone(originalCall.arguments);
```

Then implement this exact precedence:

1. If the run signal is already aborted, create an aborted synthetic result.
2. Trigger `BeforeToolCall` with `workingInput`.
3. Immediately re-check the run signal; abort wins over a returned block.
4. Convert a block or Hook exception to a blocked synthetic result.
5. Construct a new effective `AgentToolCall` from `workingInput`.
6. Call `prepare(effectiveCall)`; convert unknown/invalid to a rejected result.
7. Only for `ready`, emit `tool_start`, execute once with the run signal, run `AfterToolCall` when the run remains active, store the message, then emit `tool_end`.
8. For every rejected result, store the synthetic message, then emit exactly one `tool_rejected`.
9. Never `break` merely because the batch signal is aborted; visit every remaining call and synthesize its terminal result.

Use one helper to build stored messages so normal and synthetic paths cannot drift:

```ts
function toToolResultMessage(
  call: AgentToolCall,
  result: AgentToolResult<unknown>,
): AgentMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result.content,
    ...(result.details === undefined ? {} : { details: result.details }),
    isError: result.isError,
  };
}
```

- [ ] **Step 7: Apply AfterToolCallResult without losing fields**

Build the Hook call from the effective input and current result. When a Hook result exists, use own-property checks:

```ts
result = {
  content: hookResult.content ?? result.content,
  ...(Object.hasOwn(hookResult, "details")
    ? { details: hookResult.details }
    : result.details === undefined ? {} : { details: result.details }),
  isError: hookResult.isError ?? result.isError,
};
```

If the AfterToolCall pipeline throws, follow the existing fail-safe strategy and replace the final result with an error result. Rejected synthetic results must never enter this Hook.

- [ ] **Step 8: Run focused and full tests**

Run:

```powershell
npm run build
node --test dist/tests/agent/agent-loop.test.js dist/tests/coding-agent/agent-harness.test.js
npm test
```

Expected: all tool calls satisfy exactly one terminal lifecycle; Harness subscribers see already-persisted final messages.

- [ ] **Step 9: Commit**

```powershell
git add src/agent/types.ts src/agent/agent-loop.ts tests/agent/agent-loop.test.ts tests/coding-agent/agent-harness.test.ts
git commit -m "feat: make tool call lifecycles complete"
```

---

### Task 5: Make TodoWrite Stateless and Recoverable From Session Messages

**Files:**
- Create: `src/coding-agent/tools/todo-state.ts`
- Modify: `src/coding-agent/tools/todo-write.ts`
- Modify: `src/coding-agent/tools/index.ts`
- Modify: `tests/coding-agent/tools/todo-write.test.ts`
- Modify: `tests/coding-agent/session.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`、`AgentTool<TParameters, TDetails>` and Session current-branch `buildContext().messages`.
- Produces: `TodoItem`, `TodoDetails`, `formatTodoContent(todos)` and `findLatestTodoDetails(messages)`.

- [ ] **Step 1: Replace instance-state tests with content/details consistency tests**

Add:

```ts
test("todo_write returns the complete list in content and details", async () => {
  const tool = new TodoWriteTool();
  const result = await tool.execute({ todos: [
    { content: "Read code", status: "completed" },
    { content: "Design UI", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ] }, signal());

  assert.equal(result.content, [
    "Current tasks:",
    "1. [completed] Read code",
    "2. [in_progress] Design UI",
    "3. [pending] Add tests",
    "Updated 3 tasks",
  ].join("\n"));
  assert.deepEqual(result.details, { todos: [
    { content: "Read code", status: "completed" },
    { content: "Design UI", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ] });
});
```

Call the same tool twice and assert the second result depends only on the second full input. Do not inspect private fields.

- [ ] **Step 2: Add current-branch projection tests**

Build messages with multiple `todo_write` results, unrelated tools, missing details and malformed details. Assert:

```ts
assert.deepEqual(findLatestTodoDetails(messages), {
  todos: [{ content: "latest valid", status: "in_progress" }],
});
```

Use `Session.buildContext().messages` from a forked/current branch test so the function naturally ignores entries outside the current branch without depending on `Session` itself.

- [ ] **Step 3: Run focused tests and verify stateless/domain APIs are missing**

Run:

```powershell
npm run build
```

Expected: missing `TodoDetails`、`formatTodoContent`、`findLatestTodoDetails` and result `details` failures.

- [ ] **Step 4: Implement Todo domain validation and formatting**

In `todo-state.ts` define:

```ts
export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface TodoDetails {
  readonly todos: readonly TodoItem[];
}

export function formatTodoContent(todos: readonly TodoItem[]): string {
  return [
    "Current tasks:",
    ...todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`),
    `Updated ${todos.length} tasks`,
  ].join("\n");
}
```

Implement a structural `isTodoDetails()` and scan messages from the end:

```ts
export function findLatestTodoDetails(
  messages: readonly AgentMessage[],
): TodoDetails | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "tool" && message.name === "todo_write" &&
      isTodoDetails(message.details)) {
      return message.details;
    }
  }
  return undefined;
}
```

- [ ] **Step 5: Remove TodoWrite instance state and return one normalized fact**

Make `TodoWriteTool` extend `AgentTool<typeof parameters, TodoDetails>`. In `execute()` copy the validated input once, then derive both views:

```ts
const todos = arguments_.todos.map((todo) => ({
  content: todo.content,
  status: todo.status,
}));
return {
  content: formatTodoContent(todos),
  details: { todos },
  isError: false,
};
```

Delete `private todos` and icon-specific state formatting.

- [ ] **Step 6: Verify model-visible recovery through Harness history**

In the factory integration test, make the first model turn call `todo_write`, then inspect the second model request and assert its tool message content contains every task/status while its in-memory message still contains `details`. Repeat with a restored Session and a changed model config to prove recovery does not depend on a Tool instance.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
npm run build
node --test dist/tests/coding-agent/tools/todo-write.test.js dist/tests/coding-agent/session.test.js dist/tests/coding-agent/factory.test.js
npm test
```

Expected: TodoWrite is stateless; current-branch projection returns the last valid details; model-visible content is complete.

- [ ] **Step 8: Commit**

```powershell
git add src/coding-agent/tools tests/coding-agent/tools/todo-write.test.ts tests/coding-agent/session.test.ts tests/coding-agent/factory.test.ts
git commit -m "feat: make todo state session-derived"
```

---

### Task 6: Build the UI Renderer Boundary and Migrate Passive Hook Behavior

**Files:**
- Rename: `src/cli/frontend.ts` to `src/ui/frontend.ts`
- Delete: `src/cli/render.ts`
- Create: `src/ui/harness-renderer.ts`
- Create: `src/ui/tool-renderers.ts`
- Create: `src/ui/todo-renderer.ts`
- Modify: `src/main.ts`
- Modify: `src/agent/hooks/types.ts`
- Modify: `src/agent/hooks/registry.ts`
- Modify: `src/agent/hooks/index.ts`
- Delete: `src/coding-agent/hooks/context-inject.ts`
- Delete: `src/coding-agent/hooks/log.ts`
- Delete: `src/coding-agent/hooks/large-output.ts`
- Delete: `src/coding-agent/hooks/summary.ts`
- Modify: `src/coding-agent/hooks/factory.ts`
- Modify: `tests/agent/hooks/registry.test.ts`
- Delete: `tests/coding-agent/hooks/defaults.test.ts`
- Create: `tests/coding-agent/hooks/defaults.test.ts`
- Rename: `tests/cli/frontend.test.ts` to `tests/ui/frontend.test.ts`
- Create: `tests/ui/tool-renderers.test.ts`
- Create: `tests/ui/todo-renderer.test.ts`
- Create: `tests/ui/harness-renderer.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: final `AgentEvent`、`ToolRejectedEvent`、`AgentToolResult<unknown>`、`TodoDetails`、`Harness.subscribe()`.
- Produces: `CliToolRenderer`, `CliToolRendererRegistry`, `createDefaultToolRenderers()`, `CliHarnessRenderer` and relocated `CliFrontend`.

- [ ] **Step 1: Add renderer matching, fallback and isolation tests**

Define tests around this contract:

```ts
const registry = new CliToolRendererRegistry((message) => errors.push(message));
registry.register("todo_write", {
  renderStart: () => "todo start",
  renderEnd: () => "todo end",
  renderRejected: () => "todo rejected",
});

assert.equal(registry.renderStart(todoCall), "todo start");
assert.equal(registry.renderEnd(todoCall, okResult), "todo end");
assert.equal(registry.renderRejected(rejectedEvent), "todo rejected");
assert.match(registry.renderStart(unknownCall), /unknown/);
```

Register a renderer that throws from each method. Assert one UI error is reported and the generic fallback string is returned. Register a renderer returning `undefined`; assert fallback is returned. Test duplicate registration as an error rather than silent replacement.

- [ ] **Step 2: Add Todo and Harness renderer tests**

Todo renderer must render validated details and return `undefined` for missing/malformed details so the registry uses content fallback. Harness renderer tests must assert:

- `tool_start`、`tool_end`、`tool_rejected` are delegated to the Tool Registry;
- a `tool_end` above 100,000 content characters emits the large-output warning;
- `agent_end` emits the final tool-count summary;
- ordinary streaming/lifecycle events preserve existing line CLI behavior;
- rendering failure never throws back through the Harness listener.

- [ ] **Step 3: Add compile-time dependency and listener-removal checks**

Update smoke imports to the new `src/ui` path and add this compile-time assertion in the Hook Registry test without retaining the deleted API as executable code:

```ts
type PassiveListenerName = `register${"Listener"}`;
type PassiveListenerIsAbsent = PassiveListenerName extends keyof HookRegistry<TestContext>
  ? false
  : true;
const passiveListenerIsAbsent: PassiveListenerIsAbsent = true;
void passiveListenerIsAbsent;
```

Remove all imports of `HookListener`.

- [ ] **Step 4: Run focused tests and confirm renderer modules are missing**

Run:

```powershell
npm run build
```

Expected: missing `src/ui` modules and missing renderer symbols.

- [ ] **Step 5: Implement the Tool renderer interface and registry**

Define:

```ts
export interface CliToolRenderer {
  renderStart(call: AgentToolCall): string | undefined;
  renderEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string | undefined;
  renderRejected?(event: ToolRejectedEvent): string | undefined;
}
```

`CliToolRendererRegistry` owns a `Map<string, CliToolRenderer>`. Each render method must:

1. select by tool name;
2. call the optional specialized method inside `try/catch`;
3. use fallback if absent, returns `undefined`, or throws;
4. report exceptions only through the Registry's UI error callback.

Use these stable fallback meanings:

```ts
function fallbackStart(call: AgentToolCall): string {
  return `[exec] ${call.name}: ${JSON.stringify(call.arguments)}`;
}

function fallbackEnd(call: AgentToolCall, result: AgentToolResult<unknown>): string {
  return result.isError
    ? `[error] ${call.name}: ${result.content}`
    : `[done] ${call.name}: ${result.content}`;
}

function fallbackRejected(event: ToolRejectedEvent): string {
  return `[rejected:${event.reason}] ${event.call.name}: ${event.result.content}`;
}
```

- [ ] **Step 6: Implement Todo and Harness renderers**

`todo-renderer.ts` must validate `result.details` as `TodoDetails`, render one line per item, and return `undefined` on invalid details. `harness-renderer.ts` must own the output target and Tool Registry:

```ts
export interface CliRenderTarget {
  readonly write: (text: string) => void;
  readonly log: (text: string) => void;
}

export class CliHarnessRenderer {
  constructor(
    private readonly target: CliRenderTarget,
    private readonly tools: CliToolRendererRegistry,
  ) {}

  render(event: AgentEvent): void {
    try {
      this.renderEvent(event);
    } catch (error) {
      this.target.log(`[ui error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
```

Keep the 100,000-character warning and tool-count summary here as passive subscribe consumers, never through `CodingHookUI.notify()`.

- [ ] **Step 7: Relocate the frontend and assemble the renderer**

Move frontend code to `src/ui/frontend.ts`, construct one default renderer Registry with `todo_write` registered, construct `CliHarnessRenderer`, and subscribe with:

```ts
const unsubscribe = harness.subscribe((event) => {
  renderer.render(event);
});
```

Keep readline confirmation, ESC listener suspension/restoration, prompt loop and `close()` behavior unchanged. Update `src/main.ts` to import `./ui/frontend.js`.

- [ ] **Step 8: Remove passive Hook modules and listener API**

Delete the four passive/fake modules. Make the default factory register only permission:

```ts
export function createCodingHookRegistry(
  context: CodingHookContext,
): CodingHookRegistry {
  const registry = new HookRegistry<CodingHookContext>(context);
  registerPermissionHook(registry);
  return registry;
}
```

Delete `HookListener`、`registerListener()`、the listener Set、listener snapshot/dispatch and listener clearing logic. Rewrite registry lifecycle tests so they cover handlers, cleanup, context snapshots, AbortSignal and disposal only.

- [ ] **Step 9: Run architecture grep, focused tests and full suite**

Run:

```powershell
rg -n "HookListener|registerListener|registerContextInjectHook|registerLogHook|registerLargeOutputHook|registerSummaryHook" src
rg -n "from .*ui" src/agent src/coding-agent
npm run build
node --test dist/tests/agent/hooks/registry.test.js dist/tests/coding-agent/hooks/defaults.test.js dist/tests/ui/*.test.js dist/tests/main.test.js dist/tests/import-smoke.test.js
npm test
```

Expected: first two `rg` commands return no matches; renderer tests and full suite pass.

- [ ] **Step 10: Commit**

```powershell
git add src/agent/hooks src/coding-agent/hooks src/ui src/main.ts tests/agent/hooks tests/coding-agent/hooks tests/ui tests/main.test.ts tests/import-smoke.test.ts
git add -u src/cli tests/cli
git commit -m "feat: separate harness and tool ui rendering"
```

---

### Task 7: Align Public Exports and Package Documentation With the Finished Architecture

**Files:**
- Modify: `README.md`
- Modify: `src/ai/README.md`
- Modify: `src/agent/README.md`
- Modify: `src/agent/harness/README.md`
- Modify: `src/coding-agent/README.md`
- Modify: `docs/architecture.md`
- Modify: `src/agent/hooks/index.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/coding-agent/hooks/index.ts`
- Modify: `src/coding-agent/tools/index.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `src/index.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: every final root/barrel export and the implemented Hook、Tool、Harness、coding-agent and UI boundaries.
- Produces: complete package-facing API documentation and smoke coverage matching actual exports.

- [ ] **Step 1: Turn the import smoke test into the API inventory**

Import every intended public value/type from its package barrel. The Hook inventory must contain:

```ts
type PublicAgentHookTypes = [
  AgentHookCall,
  AgentHookTrigger,
  AfterToolCall,
  AfterToolCallResult,
  BeforeStopCall,
  BeforeStopResult,
  BeforeToolCall,
  BeforeToolCallResult,
  BeforeUserPromptCall,
  BeforeUserPromptResult,
  Cleanup,
  HookHandler<BeforeUserPromptCall, Record<string, never>>,
  ResultOf<BeforeUserPromptCall>,
  TransformContextCall,
  TransformContextResult,
  Unregister,
];
```

The coding-agent inventory must include `CodingHookContext`、`CodingHookUI`、`HookConfirmation`、`HookNotification`、`TodoItem`、`TodoDetails`、`CreateHarnessConfig`. The agent/tool inventory must include `AgentToolCall`、`AgentToolResult`、`ToolRejectedEvent`、`ToolRejectedReason`. Do not root-export `PreparedAgentToolCall`、`ToolPreparation`、CLI renderers or `NO_HOOK_UI`.

- [ ] **Step 2: Run build and fix only genuine export omissions**

Run:

```powershell
npm run build
```

Expected: any intended-but-missing barrel export fails here. Add explicit exports; do not restore wildcard exports that leak internal Registry preparation types.

- [ ] **Step 3: Update the ai README**

Document, in this order:

1. minimal `createStreamFn()` usage;
2. `ModelConfig`、`StreamFn`、`Context`、`Message`、stream event inventory;
3. `ToolResultMessage<TDetails>` as one internal message with model-visible `content` and program-visible `details`;
4. a Provider projection example showing that `details` is omitted on the wire;
5. the complete ai barrel exports and the `ai` package's no-dependency-on-agent boundary.

- [ ] **Step 4: Update the agent and harness READMEs**

The agent README must start with `runAgentLoop()` usage, then explain Agent Loop、Tools、Hook Call/reducer、AgentEvent, and finish with a complete public export inventory. Include the exact lifecycle:

```text
BeforeToolCall -> prepare -> tool_start -> execute -> AfterToolCall
               -> ToolResultMessage -> tool_end

BeforeToolCall/prepare rejected -> ToolResultMessage -> tool_rejected
```

The Harness README must explain that `subscribe()` observes already-persisted facts, Hook is injected downward for Agent control, and no `HarnessUI` inverse interface exists. List all Harness public classes/functions/types.

- [ ] **Step 5: Update the coding-agent and root READMEs**

The coding-agent README must show `createHarness()` first, then default tools, permission Hook, `CodingHookUI`, Todo content/details/state projection and complete exports. Explicitly state that default Hooks contain only permission and that passive logging/summary/large-output live in UI subscribe consumers.

The root README must update the package dependency direction and source tree to `src/ui`, explain the difference among Hook UI、Harness UI and Tool UI in prose, and keep detailed design rationale in the spec rather than duplicating it.

- [ ] **Step 6: Rewrite architecture.md to describe the implemented state**

Delete all `HookListener/registerListener` tables and event-named Hook input types. Add:

- Call naming and mutability rules;
- `content/details` split and Provider projection;
- two-phase Registry ownership;
- exactly-one Tool terminal event;
- `ui -> coding-agent -> agent -> ai` source dependency;
- Todo state projection in coding-agent rather than UI;
- the concrete `src/ui` file responsibilities.

Do not describe future durable lanes, widgets, ExtensionHost or RPC as implemented.

- [ ] **Step 7: Run documentation and boundary audits**

Run:

```powershell
rg -n "HookListener|registerListener|ContextEvent|ToolCallEvent|ToolResultEvent|UserPromptEvent|StopEvent|PermissionRequest|src/cli" README.md src/*/README.md src/agent/harness/README.md docs/architecture.md src tests
rg -n "Invocation" README.md src docs/architecture.md tests
rg -n "from .*ui" src/ai src/agent src/coding-agent
npm run typecheck
npm test
```

Expected: all three `rg` commands return no matches; typecheck and the entire test suite pass.

- [ ] **Step 8: Inspect the final diff for accidental public leakage**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors, only planned files changed, and no generated `dist` files staged.

- [ ] **Step 9: Commit**

```powershell
git add README.md src/ai/README.md src/agent/README.md src/agent/harness/README.md src/coding-agent/README.md docs/architecture.md src/agent/hooks/index.ts src/agent/tools/index.ts src/coding-agent/hooks/index.ts src/coding-agent/tools/index.ts src/coding-agent/index.ts src/index.ts tests/import-smoke.test.ts
git commit -m "docs: explain hook harness and tool ui boundaries"
```

---

## Final Verification

- [ ] Run `npm run typecheck` and confirm zero diagnostics.
- [ ] Run `npm test` and record the exact passing test count.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run `git status --short` and confirm only intentionally uncommitted plan-tracking edits remain.
- [ ] Compare all 19 acceptance criteria in the approved spec against the implemented code and name the test or documentation section that proves each one.
