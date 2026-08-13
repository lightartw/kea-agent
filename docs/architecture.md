# Kea Agent 架构

**更新：** 2026-08-13

> 本文描述当前已实现的代码架构。Hook 输入使用 `Call` 命名，passive listener/observer
> 已删除，被动展示统一走 Harness `subscribe`，具体 CLI UI 位于 `src/ui`。

依赖从底层往上，每层只依赖它的下层。源码箭头始终向下：

```text
main.ts
  ├── UI (CliFrontend, CliHarnessRenderer, CliInteractions)
  ├── Coding Agent (createCodingAgent, 默认 permission Hook, Bash 策略, Todo 投影)
  ├── Agent Harness (AgentHarness, Session, SessionManager)
  ├── Agent (runAgentLoop, HookRegistry, AgentToolRegistry)
  └── AI (StreamFn, ModelConfig, Message, Adapter)
```

```text
ui -> coding-agent -> harness -> agent -> ai
```

---

## 1. AI — LLM 客户端抽象

位于 `src/ai/`。统一 Anthropic / OpenAI / Gemini 的流式协议。不保存会话，不执行工具。

### 核心类型

```ts
type StreamFn = (
  model: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<AssistantMessageEvent>;

interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}

interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}

type AssistantMessageEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argumentsDelta: string }
  | { type: "toolcall_end"; toolCall: ToolCall }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message: AssistantMessage };
```

### 核心函数

```ts
function createStreamFn(options?: {
  providers?: ProviderConfig[];
  env?: Environment;
}): { stream: StreamFn; defaultModel: ModelConfig };
```

`createStreamFn` 只检查 API key 环境变量，不根据模型名猜测。provider adapter 首次被迭代时才动态 `import()`，之后复用。

### `ToolResultMessage` 的 `content` / `details` 分层

```ts
interface ToolResultMessage<TDetails = unknown> {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly details?: TDetails;
  readonly isError?: boolean;
}
```

`content` 是模型可见文本；`details` 是程序可见的结构化数据。Provider adapter 只投影
对应 Provider 需要的字段，`details` 永远不进网络请求：

```text
content  -> Provider wire payload
details  -> Session / Agent / UI 内存消息
```

---

## 2. Agent — 多 Turn 工具循环 + Hook 控制通道

位于 `src/agent/`。依赖 AI 层的 `StreamFn`、`ModelConfig`、`Message`。

### 2.1 runAgentLoop

纯函数，不持有实例状态，但原地修改 `context.messages`。

```ts
function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent>;

interface AgentContext {
  readonly systemPrompt: string;
  messages: AgentMessage[];
  readonly tools: AgentToolRegistry;
}

interface AgentLoopConfig {
  readonly model: ModelConfig;
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  readonly hooks: AgentHookTrigger;   // 窄触发接口，看不到 register/context/lifecycle
}
```

**执行顺序：**

1. `user_prompt` hook → 未 block 则写入 user message
2. 每 turn 复制消息 → `context` hook 变换请求消息（只影响本次 LLM 请求）
3. 调用 `StreamFn`，转发 text/thinking/tool-call 增量
4. 无 tool call → `stop` hook（可 `continueWith` 续跑）→ 结束
5. 有 tool call → 逐个按下方生命周期处理

### 工具调用生命周期

每个来自最终 assistant message 的 `AgentToolCall` 恰好产生一个终态：

```text
BeforeToolCall -> prepare -> tool_start -> execute -> AfterToolCall
               -> ToolResultMessage -> tool_end

BeforeToolCall/prepare 被拒绝 -> ToolResultMessage -> tool_rejected
```

- 原始 call 的 `arguments` 先 `structuredClone` 成工作副本，再交给 `BeforeToolCall` 修改。
- `prepare()` 完成 lookup 和最终参数验证；只有 `ready` 才发射 `tool_start` 并执行。
- 被 block、参数无效、工具不存在或已 Abort 的调用合成 synthetic `ToolResultMessage` 并
  发射恰好一个 `tool_rejected`，不会静默丢失。
- 批处理中途 Abort：已开始的调用照常 `tool_end`，其余调用各得一个 `aborted` 的 `tool_rejected`。
- `AfterToolCallResult` 修改 `details` 时必须同时返回完整 `content`。

### 2.2 AgentEvent

观察通道。Harness 的 `subscribe()` 发布这些事件，返回值被忽略。

```ts
type ToolRejectedReason = "blocked" | "invalid" | "unknown" | "aborted";

interface ToolRejectedEvent {
  readonly type: "tool_rejected";
  readonly call: AgentToolCall;                          // 模型原始请求
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult;
  readonly reason: ToolRejectedReason;
}

type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: readonly AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argumentsDelta: string }
  | { type: "toolcall_end"; toolCall: AgentToolCall }
  | { type: "tool_start"; call: AgentToolCall }
  | { type: "tool_end"; call: AgentToolCall; result: AgentToolResult }
  | ToolRejectedEvent;
```

### 2.3 HookRegistry — 控制通道

位于 `src/agent/hooks/`。与 `AgentEvent` 互补：Hook 在动作提交**前**触发，可阻止/变换/修补/续跑。没有 passive listener/observer。

```ts
class HookRegistry<TContext> {
  constructor(context: TContext);
  get context(): TContext;
  setContext(context: TContext): void;

  register<TType extends AgentHookCall["type"]>(
    type: TType,
    handler: HookHandler<Extract<AgentHookCall, { type: TType }>, TContext>,
  ): Unregister;

  trigger<T extends AgentHookCall>(
    call: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined>;

  addCleanup(cleanup: Cleanup): Unregister;
  clear(): Promise<void>;    // 逆序执行 cleanup，可复用
  dispose(): Promise<void>;  // 永久销毁，不可复用
}
```

**五种 Agent Hook Call：**

| Call | 类型 | Handler 组合规则 | 结果类型 |
| ---- | ---- | ---------------- | -------- |
| `user_prompt` | `BeforeUserPromptCall` | 顺序；首个 `block: true` 提前结束 | `{ block?; reason? }` |
| `context` | `TransformContextCall` | 顺序应用 `messages`；后一个看到前一个结果 | `{ messages? }` |
| `tool_call` | `BeforeToolCall` | 顺序共享可变 `input`；首个 `block: true` 提前结束 | `{ block?; reason? }` |
| `tool_result` | `AfterToolCall` | 顺序应用 Result；后一个看到前一个结果 | `AfterToolCallResult` |
| `stop` | `BeforeStopCall` | 首个 `continueWith` 提前结束 | `{ continueWith? }` |

**语义：** 每次 `trigger()` 进入时快照 context/handler 列表；触发期间注册/注销只影响下次 trigger；`Unregister` 幂等；Handler 错误原样穿透。

### 2.4 AgentHookTrigger — 接口收窄

`HookRegistry` 提供完整配置面，但运行时（Loop / Harness）只需要触发能力，因此用
`AgentHookTrigger` 收窄到只暴露 `trigger`：

```ts
interface AgentHookTrigger {
  trigger<TCall extends AgentHookCall>(
    call: TCall,
    signal?: AbortSignal,
  ): Promise<ResultOf<TCall> | undefined>;
}
```

### 2.5 工具系统

```ts
abstract class AgentTool<
  TParameters extends TObject = TObject,
  TDetails = unknown,
> implements Tool {
  protected constructor(name: string, description: string, parameters: TParameters);
  validate(arguments_: unknown): string | undefined;
  abstract execute(
    args: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}

class AgentToolRegistry {
  constructor(timeout?: number);  // 默认 120s
  register(tool: AgentTool): void;
  unregister(name: string): void;
  schemas(): Tool[];
  all(): AgentTool[];
  prepare(call: AgentToolCall): ToolPreparation;
  execute(prepared: PreparedAgentToolCall, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
}

interface AgentToolResult<TDetails = unknown> {
  readonly content: string;
  readonly details?: TDetails;
  readonly isError: boolean;
}
```

Registry 拆成两阶段：`prepare(call)` 返回 `ready`（携带 `prepared`）或 `rejected`
（携带 `reason: "unknown" | "invalid"` 与 synthetic result）。`execute(prepared)` 只负责
timeout 和异常归一化，不重复 lookup 或 validate。`ToolPreparation` 与
`PreparedAgentToolCall` 是模块内部类型，不从公开入口导出。

### 典型用法

```ts
const hooks = new HookRegistry<MyContext>(ctx);
hooks.register("tool_call", async (call, ctx) => {
  if (dangerous) return { block: true, reason: "not allowed" };
});

const loop = runAgentLoop(input, context, { model, convertToLlm, hooks }, streamFn);
for await (const event of loop) { /* render */ }
```

---

## 3. Agent Harness — 有状态运行时

位于 `src/harness/`。依赖 Agent 层的 `runAgentLoop`、`AgentHookTrigger`、`AgentToolRegistry`。

### 3.1 AgentHarness

核心类。持有消息、模型、Session；调用 `runAgentLoop()`；管理运行状态与 AbortController；在发布事件前持久化消息。

```ts
class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  subscribe(listener: HarnessListener): Unsubscribe;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}

interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
  readonly hooks?: AgentHookTrigger;  // 未传入时使用空 Registry
}
```

`switchModel`、`registerTool`、`unregisterTool` 仅在 idle 时可用。

`prompt()` 在发布每个事件前先 `persistNewMessages()`，因此 `subscribe` 观察到的
`tool_end` / `tool_rejected` 时，对应的 `ToolResultMessage` 已经在 Session 里。

### 3.2 System Prompt

```ts
type SystemPromptBuilder = (ctx: SystemPromptContext) => string | Promise<string>;

interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

function formatSystemPrompt(content: string, options?: { cwd?: string; date?: Date }): string;
function defaultSystemPrompt(template: string): SystemPromptBuilder;
```

### 3.3 Session — 树形 JSONL 持久化

基于 `id` / `parentId` 的 entry tree，延迟首次写入。

```ts
class Session {
  static create(storageDir: string): Promise<Session>;
  static open(storageDir: string, sessionId: string): Promise<Session>;
  static inMemory(): Session;                           // 测试用

  appendMessage(message: AgentMessage): Promise<void>;
  appendModelChange(model: ModelConfig): Promise<void>;
  buildContext(): SessionContext;                       // 按 leaf 父链恢复 { messages, model }
}

class SessionError extends Error {
  readonly code: "not_found" | "invalid_session" | "invalid_entry" | "storage";
}
```

- 第一条 assistant message 前只在内存缓冲，首次 flush 用 `writeFile(…, "wx")` 原子创建文件
- 后续追加用追加写
- `open()` 校验 JSON、entry 结构、重复 ID、父引用、根数量、消息字段（含 `details` 的 JSON-safe 校验）
- 写入失败回滚内存 entry 和 leaf
- 内部序列化追加（`enqueue`）

### 3.4 SessionManager

管理一个 project 下的多个 Session 文件（列出、恢复最近会话）。

```ts
class SessionManager {
  constructor(project: HarnessProject);
  continueRecent(): Promise<Session>;    // 最新或新建
  listSessions(): Promise<string[]>;     // 按 mtime 倒序
}
```

---

## 4. Coding Agent — 默认能力组合

位于 `src/coding-agent/`。依赖 Harness 层和 Agent 层。是 `coding-agent` → 下层的唯一组合点。

### 4.1 `createCodingAgent`

```ts
interface CreateCodingAgentConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;  // 默认 CODING_SYSTEM_PROMPT
  readonly interactions?: CodingAgentInteractions;      // 默认 NO_INTERACTIONS（fail-closed）
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}

function createCodingAgent(
  config: CreateCodingAgentConfig,
): Promise<CodingAgentRuntime>;
```

组装：创建内置 Tool Definition → 投影为 `AgentTool` 并注册 → 注册各 Tool 的
presentation → 创建默认 HookRegistry（注入 `interactions`）→ `new AgentHarness(…)` → 返回
Harness 和 presentation registry。

### 4.2 `CodingAgentInteractions` — UI 注入端口

Coding Agent 定义此接口，UI 实现。coding-agent 永不导入 UI 代码。

```ts
interface CodingAgentInteractions {
  readonly available: boolean;
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}

interface ConfirmationRequest {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

interface Notification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}
```

### 4.3 默认 Hook：只有 permission

`createDefaultCodingHookRegistry(context)` 只注册 permission。被动的 log、large-output、summary
不再是 Hook，而是 UI 层针对 Harness `subscribe` 事件的 presentation 行为。

| Hook | 事件 | 行为 |
| ---- | ---- | ---- |
| Permission | `tool_call` | Bash 的 allow/ask/deny；ask 时调 `interactions.confirm()` |

### 4.4 Bash 安全策略

位于 `tools/builtin/bash/policy.ts`，是 Permission Hook 与 Bash Tool Definition 的**单一共享来源**。

```ts
function classifyBashCommand(command: string): BashDecision;
function hardDeniedBashReason(command: string): string | undefined;
```

**三级策略：**

| 级别 | 示例 | 行为 |
| ---- | ---- | ---- |
| 硬拒绝 | `sudo`、`mkfs`、`dd if=`、`> /dev/`、`rm -rf /` | Hook 和 Bash Tool Definition 均阻止，不询问 UI |
| 询问 | `rm`、`> /etc/`、`chmod 777` | Hook 调用 `interactions.confirm()`；无交互 Adapter 时 fail-closed |
| 允许 | `pwd`、`git status` | 直接放行 |

### 4.5 Todo 状态投影

`todo_write` 无实例状态；`TodoItem`/`TodoDetails`/`formatTodoContent`/
`findLatestTodoDetails` 位于 coding-agent 的 `tools/builtin/todo/projection.ts`。Todo 真实状态定义为
「当前 Session 分支中最后一条有效 `todo_write` ToolResultMessage 的 `details.todos`」，
由 `findLatestTodoDetails` 从 `AgentMessage[]` 投影，不在 UI 层。

### 组装用法

```ts
const runtime = await createCodingAgent({
  project: { workDir, storageDir },
  streamFn: stream,
  model: defaultModel,
  session,
  interactions: myInteractions,   // 实现 CodingAgentInteractions
});
await runtime.harness.prompt("list files");
```

---

## 5. UI — 具体前端

位于 `src/ui/`。依赖 Harness 层（`AgentHarness`）和 Coding Agent（`CodingAgentRuntime`、
`CodingAgentInteractions`）。
`agent`、`harness`、`coding-agent` 不 import `src/ui`。

```text
src/ui/
  cli-frontend.ts          # CliFrontend、输入循环、装配
  cli-interactions.ts      # CodingAgentInteractions 的 readline Adapter
  cli-harness-renderer.ts  # Harness Event 展示；调用 presentation registry
```

### 5.1 CLI Adapter

`CliInteractions` 实现 `CodingAgentInteractions`；`CliFrontend` 通过
`runtime.harness.subscribe()` 消费 `HarnessEvent`，并交给 `CliHarnessRenderer`。

```ts
class CliFrontend {
  constructor(options?: CliFrontendOptions);

  get interactions(): CodingAgentInteractions;
  run(runtime: CodingAgentRuntime): Promise<void>;
  close(): void;
}
```

**行为：**

- `>>` 提示符输入，`q`/`exit`/空行退出
- ESC 中止流式响应（`runtime.harness.abort()`）
- `CliInteractions.confirm()` 期间暂停 ESC 监听器，展示 `[y/N]` 提示（空输入默认拒绝）；ESC 等同于 N
- `CliInteractions.confirm()` 支持外部 `AbortSignal`，与内部 ESC 通过 `AbortSignal.any()` 合并
- `run()` 创建 `CliHarnessRenderer`，并订阅 `runtime.harness`

### 5.2 Tool presentation 边界

`AgentTool` 不依赖 UI、不携带 presentation。每个 Coding Tool Definition 可选地携带
`CodingToolPresentation`；`createCodingAgent()` 将它们注册到 runtime 的
`CodingToolPresentationRegistry`。UI 把 `HarnessToolEvent` 交给 registry：

```ts
interface CodingToolPresentation<TArguments, TDetails> {
  renderStart(call: ToolPresentationCall<TArguments>): string | undefined;
  renderEnd(
    call: ToolPresentationCall<TArguments>,
    result: AgentToolResult<TDetails>,
  ): string | undefined;
  renderRejected?(event: ToolPresentationRejected<TArguments>): string | undefined;
}
```

行为：有专用 presentation 用专用展示；返回 `undefined` 或抛错时回退到 content fallback；
presentation 错误只报告诊断，绝不影响 Agent 执行。

### 运行示例

```ts
const cli = new CliFrontend();
const runtime = await createCodingAgent({ ..., interactions: cli.interactions });
await cli.run(runtime);
```

---

## 6. main.ts — 组合根

`src/main.ts`。唯一的应用启动点，按顺序连接所有层。

```text
loadDotenv → createStreamFn → resolveProject → Session.create
  → createCodingAgent({ ..., interactions: cli.interactions }) → cli.run(runtime)
```

---

## 公共导出

| 入口 | 核心导出 |
| ---- | -------- |
| `src/index.ts` | 全部公共类型 + `createStreamFn` + `HookRegistry` |
| `src/ai/index.ts` | `StreamFn`、`ModelConfig`、`Message`、`Context`、`Tool`、`ToolResultMessage`、`AssistantMessageEvent`、`createStreamFn` |
| `src/agent/hooks/index.ts` | `HookRegistry`、`AgentHookTrigger`、`AgentHookCall` 及各 Call/Result 类型、`ResultOf`、`HookHandler` |
| `src/agent/tools/index.ts` | `AgentTool`、`AgentToolRegistry`、`AgentToolCall`、`AgentToolResult` |
| `src/harness/index.ts` | `AgentHarness`、`Session`、`SessionError`、`SessionManager`、`defaultSystemPrompt`、`HarnessConfig` |
| `src/coding-agent/index.ts` | `createCodingAgent`、`createDefaultCodingHookRegistry`、`createDefaultToolDefinitions`、`toAgentTool`、`CODING_SYSTEM_PROMPT`、`NO_INTERACTIONS`、`CodingToolPresentationRegistry` 及其公开配置、Hook、interaction、Tool/presentation、Todo 类型 |

`PreparedAgentToolCall`、`ToolPreparation`、具体 CLI Adapter、内置 Tool/Hook 实现和 Bash policy helpers
不作为 Coding Agent 根入口的稳定公共 API。

## 边界约束

- `ai` 不依赖 `agent`
- `agent` 不依赖 `coding-agent` 或 `ui`
- `coding-agent` 不依赖 `ui`（通过 `CodingAgentInteractions` port 依赖倒置）
- `ui -> coding-agent -> harness -> agent -> ai`
- UI 解耦用两种机制：Hook 走泛型 `TContext`（运行时注入 `{ cwd, interactions }`），Tool 走构造注入（组合根捕获 `CodingToolContext`，`execute` 接收它）
- `main.ts` 是唯一连接所有层的文件
