# Kea Agent 架构

**更新：** 2026-08-12

依赖从底层往上，每层只依赖它的下层。源码箭头始终向下：

```text
main.ts
  ├── CLI (CliFrontend)
  ├── Coding Agent (createHarness, 默认 Hook, Bash 策略)
  ├── Agent Harness (AgentHarness, Session, SessionManager)
  ├── Agent (runAgentLoop, HookRegistry, AgentToolRegistry)
  └── AI (StreamFn, ModelConfig, Message, Adapter)
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
  readonly provider: string;   // "anthropic" | "openai" | "gemini"
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
// 工厂：从环境变量或显式配置创建路由函数
function createStreamFn(options?: {
  providers?: ProviderConfig[];
  env?: Environment;
}): { stream: StreamFn; defaultModel: ModelConfig };
```

### 用法

```ts
const { stream, defaultModel } = createStreamFn();
// stream({ provider: "anthropic", model: "claude-sonnet-5" }, context);
```

`createStreamFn` 只检查 API key 环境变量，不根据模型名猜测。provider adapter 首次被迭代时才动态 `import()`，之后复用。

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
5. 有 tool call → `tool_call` hook（可 block/改 input）→ 执行 → `tool_result` hook（可 patch 结果）→ 结果一致存入 history + `tool_end`

### 2.2 AgentEvent

观察通道。Harness 的 `subscribe()` 发布这些事件，返回值被忽略。

```ts
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
  | { type: "tool_end"; call: AgentToolCall; result: AgentToolResult };
```

### 2.3 HookRegistry — 控制通道

位于 `src/agent/hooks/`。与 `AgentEvent` 互补：Hook 在动作提交**前**触发，可阻止/变换/修补/续跑。

```ts
class HookRegistry<TContext> {
  constructor(context: TContext);
  get context(): TContext;
  setContext(context: TContext): void;

  register<TType extends AgentHookEvent["type"]>(
    type: TType,
    handler: HookHandler<Extract<AgentHookEvent, { type: TType }>, TContext>,
  ): Unregister;

  registerListener(listener: HookListener<AgentHookEvent, TContext>): Unregister;

  trigger<T extends AgentHookEvent>(event: T, signal?: AbortSignal): Promise<ResultOf<T> | undefined>;

  addCleanup(cleanup: Cleanup): Unregister;
  clear(): Promise<void>;    // 逆序执行 cleanup，可复用
  dispose(): Promise<void>;  // 永久销毁，不可复用
}
```

**Handler 与 Listener 的区别：**

| | Handler | Listener |
| --- | --- | --- |
| 注册方式 | `register(事件名, fn)` — 绑定单个事件类型 | `registerListener(fn)` — 绑定所有事件类型 |
| 能控制流程？ | ✅ 能 block/修改（返回值被合并） | ❌ 只能旁观（返回值被忽略） |
| 典型用途 | 权限校验、内容过滤、消息注入 | 打日志、发通知、度量统计 |

每次 `trigger()` 执行时：先通知所有 Listener → 再按注册顺序调用 Handler → 根据事件类型应用不同的组合规则。

**五种 Agent Hook 事件：**

| 事件 | Handler 组合规则 | 结果类型 |
| ------ | ----------------- | --------- |
| `user_prompt` | 顺序；首个 `block: true` 提前结束 | `{ block?: boolean; reason?: string }` |
| `context` | 顺序应用 `messages`；后一个看到前一个结果 | `{ messages?: AgentMessage[] }` |
| `tool_call` | 顺序共享可变 `input`；首个 `block: true` 提前结束 | `{ block?: boolean; reason?: string }` |
| `tool_result` | 顺序应用 patch；后一个看到前一个结果 | `{ content?: string; isError?: boolean }` |
| `stop` | 首个 `continueWith` 提前结束 | `{ continueWith?: AgentMessage }` |

**语义：** 每次 `trigger()` 进入时快照 context/listener/handler 列表；触发期间注册/注销只影响下次 trigger；`Unregister` 幂等；Handler/Listener 错误原样穿透。

### 2.4 AgentHookTrigger — 接口收窄

`HookRegistry` 提供了完整的配置面（`register`、`registerListener`、`setContext`、`clear`、`dispose`），但运行时（Loop / Harness）只需要触发能力。如果给 Loop 传整个 `HookRegistry`，Loop 就能调用 `hooks.clear()` 把别人的 handler 全删掉——这不应该发生。

因此用 `AgentHookTrigger` 收窄到**只暴露 `trigger` 一个方法**：

```ts
interface AgentHookTrigger {
  trigger<TEvent extends AgentHookEvent>(
    event: TEvent,
    signal?: AbortSignal,
  ): Promise<ResultOf<TEvent> | undefined>;
}
```

分工明确：

```text
工厂代码（装配阶段）              运行时（Loop / Harness）
─────────────────                ───────────────────────
new HookRegistry(context)        config.hooks.trigger(...)
  ↓ 完整 API                        ↓ 只看到一个 trigger
hooks.register("tool_call",...)  不能 register、不能 clear
hooks.registerListener(...)      只能 trigger
  ↓
传 hooks 给 AgentLoopConfig
```

这是面向对象的**接口隔离原则**：调用方看到什么接口，取决于它需要什么能力；不需要的能力就不暴露，避免误用。

### 2.5 工具系统

```ts
abstract class AgentTool<TParameters extends TObject = TObject> implements Tool {
  protected constructor(name: string, description: string, parameters: TParameters);
  validate(arguments_: unknown): string | undefined;
  abstract execute(args: Static<TParameters>, timeoutSignal: AbortSignal): Promise<AgentToolResult>;
}

class AgentToolRegistry {
  constructor(timeout?: number);  // 默认 120s
  register(tool: AgentTool): void;
  unregister(name: string): void;
  schemas(): Tool[];
  all(): AgentTool[];
  execute(call: AgentToolCall): Promise<AgentToolResult>;
}

interface AgentToolResult { readonly content: string; readonly isError: boolean; }
```

### 典型用法

```ts
const hooks = new HookRegistry<MyContext>(ctx);
hooks.register("tool_call", async (event, ctx) => {
  if (dangerous) return { block: true, reason: "not allowed" };
});

const loop = runAgentLoop(input, context, { model, convertToLlm, hooks }, streamFn);
for await (const event of loop) { /* render */ }
```

---

## 3. Agent Harness — 有状态运行时

位于 `src/agent/harness/`。依赖 Agent 层的 `runAgentLoop`、`AgentHookTrigger`、`AgentToolRegistry`。

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

`switchModel`、`registerTool`、`unregisterTool` 仅在 idle 时可用；`isRunning` 为 true 时调用抛错。

### 3.2 System Prompt

```ts
type SystemPromptBuilder = (ctx: SystemPromptContext) => string | Promise<string>;

interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

// 工具函数
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
- 后续追加用 `appendFile()`
- `open()` 校验 JSON、entry 结构、重复 ID、父引用、根数量、消息字段
- 写入失败回滚内存 entry 和 leaf
- 内部序列化追加（`enqueue`）

### 3.4 SessionManager

管理一个 project 下的多个 Session 文件（列出、恢复最近会话）。它不负责创建/打开单个 Session —— 那属于 `Session.create()` / `Session.open()`，二者也是 `continueRecent()` 的底层实现。

```ts
class SessionManager {
  constructor(project: HarnessProject);
  continueRecent(): Promise<Session>;    // 最新或新建
  listSessions(): Promise<string[]>;     // 按 mtime 倒序
}
```

### 最小用法

```ts
// 新建：Session.create 负责建立 sessions 目录
const session = await Session.create(storageDir);

// 恢复最近一次会话（不存在则新建）
const session = await new SessionManager({ workDir, storageDir }).continueRecent();

const harness = new AgentHarness({
  session, model, streamFn, toolRegistry, systemPrompt, cwd,
});
await harness.prompt("hello");
```

---

## 4. Coding Agent — 默认能力组合

位于 `src/coding-agent/`。依赖 Harness 层和 Agent 层。是 `coding-agent` → 下层的唯一组合点。

### 4.1 createHarness

```ts
interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;  // 默认 CODING_SYSTEM_PROMPT
  readonly ui?: CodingHookUI;                            // 默认 NO_UI（fail-closed）
}

function createHarness(config: CreateHarnessConfig): Promise<AgentHarness>;
```

组装：创建默认工具集 → 创建默认 HookRegistry（注入 `ui`）→ `new AgentHarness(…)`。

### 4.2 CodingHookUI — UI 注入端口

Coding Agent 定义此接口，CLI 实现。coding-agent 永不导入 CLI 代码。

```ts
interface CodingHookUI {
  readonly available: boolean;
  confirm(request: PermissionRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: HookNotification): void | Promise<void>;
}
```

### 4.3 五个默认 Hook

通过 `createCodingHookRegistry(context)` 组装：

| Hook | 事件 | 类型 | 行为 |
| ------ | ------ | ------ | ------ |
| Context Inject | `user_prompt` | Handler | `ui.notify` 当前 cwd |
| Permission | `tool_call` | Handler | Bash 的 allow/ask/deny；ask 时调 `ui.confirm()` |
| Log | 全部 | Listener | 记录 `[HOOK] toolName(...)` |
| Large Output | `tool_result` | Listener | content > 100k 字符时 warning |
| Summary | `stop` | Handler | 统计 tool message 数并 notify |

### 4.4 Bash 安全策略

位于 `bash-policy.ts`，是 Permission Hook 与 `BashTool` 的**单一共享来源**。

```ts
function classifyBashCommand(command: string): BashDecision;
// → { decision: "allow" }
// | { decision: "ask"; reason: string }
// | { decision: "deny"; reason: string }

function hardDeniedBashReason(command: string): string | undefined;
// BashTool 自身的后防线，绕过 Hook 直接阻止
```

**三级策略：**

| 级别 | 示例 | 行为 |
| ------ | ------ | ------ |
| 硬拒绝 | `sudo`、`mkfs`、`dd if=`、`> /dev/`、`rm -rf /` | Hook 和 BashTool 均阻止，不询问 UI |
| 询问 | `rm`、`> /etc/`、`chmod 777` | Hook 调用 `ui.confirm()`；无 UI 时 fail-closed |
| 允许 | `pwd`、`git status` | 直接放行 |

### 组装用法

```ts
const harness = await createHarness({
  project: { workDir, storageDir },
  streamFn: stream,
  model: defaultModel,
  session,
  ui: myUI,   // 实现 CodingHookUI
});
await harness.prompt("list files");
```

---

## 5. CLI — readline 前端

位于 `src/cli/`。依赖 Harness 层（`AgentHarness`）和 Coding Agent（`CodingHookUI`、`PermissionRequest`）。

### 5.1 CliFrontend

实现 `CodingHookUI`，通过 subscribe 消费 `AgentEvent` 渲染。

```ts
class CliFrontend implements CodingHookUI {
  readonly available = true;
  constructor(options?: CliFrontendOptions);  // 可注入 I/O 缝线（测试用）

  // CodingHookUI
  confirm(request: PermissionRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: HookNotification): void;

  // 主循环
  run(harness: AgentHarness): Promise<void>;
  close(): void;
}
```

**行为：**

- `>>` 提示符输入，`q`/`exit`/空行退出
- ESC 中止流式响应（`harness.abort()`）
- `confirm()` 期间暂停 ESC 监听器，展示 `[y/N]` 提示（空输入默认拒绝）；ESC 等同于 N
- `confirm()` 支持外部 `AbortSignal`，与内部 ESC 通过 `AbortSignal.any()` 合并

### 运行示例

```ts
const cli = new CliFrontend();
await cli.run(harness);
```

---

## 6. main.ts — 组合根

`src/main.ts`。唯一的应用启动点，按顺序连接所有层。

```text
loadDotenv → createStreamFn → resolveProject → Session.create
  → createHarness({ ..., ui: cli }) → cli.run(harness)
```

---

## 公共导出

| 入口 | 核心导出 |
| ------ | --------- |
| `src/index.ts` | 全部公共类型 + `createStreamFn` + `HookRegistry` |
| `src/ai/index.ts` | `StreamFn`、`ModelConfig`、`Message`、`Context`、`Tool`、`AssistantMessageEvent`、`createStreamFn` |
| `src/agent/hooks/index.ts` | `HookRegistry`、`AgentHookTrigger`、五种事件类型、`ResultOf`、`HookHandler`、`HookListener` |
| `src/agent/harness/index.ts` | `AgentHarness`、`Session`、`SessionError`、`SessionManager`、`defaultSystemPrompt`、`HarnessConfig` |
| `src/coding-agent/index.ts` | `createHarness`、`createCodingHookRegistry`、`CodingHookUI`、`CodingHookContext`、`CreateHarnessConfig`、`PermissionRequest`、`HookNotification` |

## 边界约束

- `ai` 不依赖 `agent`
- `agent` 不依赖 `coding-agent` 或 `cli`
- `coding-agent` 不依赖 `cli`（通过 `CodingHookUI` port 依赖倒置）
- UI 解耦用两种机制：Hook 走泛型 `TContext`（运行时注入 `{ cwd, ui }`），Tool 走构造注入（组合根捕获依赖，`execute` 无 context）。详见 `agent/README.md`「与 UI 的解耦」
- `main.ts` 是唯一连接所有层的文件
