# ai

`ai` 是 LLM 请求边界。它统一 provider 的流式协议，并提供无状态的
`ModelRuntime`。调用者每次显式传入模型配置和完整上下文；本包不保存模型选择、历史、
Session 或 Agent Run，也不执行工具或控制 agent loop。

## 用法

```ts
import { createModelRuntime, type Context } from "./core/ai/index.js";

const { runtime, modelConfig } = createModelRuntime();
const context: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of runtime.stream(modelConfig, context)) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "error") console.error(event.message.errorMessage);
}
```

`ModelRuntime` 是“怎样请求模型”的能力：它拥有 provider 路由和 lazy adapter。
`ModelConfig` 是“这次请求选择哪个模型”的值。因此 Runtime 不保存当前模型或默认模型；
同一个 Runtime 可服务多个 provider、Session 和模型切换。

一次 `runtime.stream()` 调用是一个 LLM turn。tool call 只是输出协议；调用者执行工具后，
把 `ToolResultMessage` 加入下一次调用的 `Context.messages`。

`runtime.complete()` 消费同一条 stream 路由，并返回 `done` 或 `error` 终止块中的完整
assistant message。流没有终止块时它会拒绝。它不承担标题生成、compaction 或工具循环停止判断；
当前 Agent Loop 直接按本轮是否产生 Tool Result 决定是否继续。

## Provider 与模型切换

`createModelRuntime()` 找出所有已配置 provider，为它们创建 lazy adapter，并返回同一个
Runtime。内置配置如下：

| Provider | API key | 可选 base URL |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` |

`MODEL_ID` 必须提供。只有一家 provider 时自动作为默认；多家时必须设置
`DEFAULT_PROVIDER`。默认项只决定 factory 返回的启动 `modelConfig`，不限制其他已配置 provider。

```ts
const { runtime } = createModelRuntime({
  env: {
    ANTHROPIC_API_KEY: "...",
    OPENAI_API_KEY: "...",
    DEFAULT_PROVIDER: "anthropic",
    MODEL_ID: "claude-sonnet-5",
  },
});

// 切换 model/provider 不需要重建 Runtime。
for await (const event of runtime.stream(
  { provider: "openai", model: "gpt-5" },
  context,
)) {
  // ...
}
```

应用可以先从 JSON 等配置源准备环境变量；配置文件的读取、合并和保存不属于 `ai`。
adapter 第一次使用时加载，之后复用。请求未配置 provider 会抛出 `Unknown provider`。

自定义 provider 通过 `ProviderConfig` 追加：

```ts
const deepseek: ProviderConfig = {
  id: "deepseek",
  envApiKey: "DEEPSEEK_API_KEY",
  envBaseUrl: "DEEPSEEK_BASE_URL",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  createAdapter: (key, url) => new MyAdapter(key, url),
};

const { runtime, modelConfig } = createModelRuntime({ providers: [deepseek] });
```

## 完整公开接口

`ai/index.ts` 只公开下面这些符号。

### Factory

```ts
interface ProviderConfig {
  readonly id: string;
  readonly envApiKey: string;
  readonly envBaseUrl?: string;
  readonly defaultBaseUrl?: string;
  readonly createAdapter: (
    apiKey: string,
    baseUrl?: string | null,
  ) => Adapter;
}

function createModelRuntime(options?: {
  providers?: ProviderConfig[];
  env?: Readonly<Record<string, string | undefined>>;
}): {
  runtime: ModelRuntime;
  modelConfig: ModelConfig;
};
```

`Adapter` 出现在扩展函数签名中，但没有从 `ai/index.ts` 导出；自定义实现按结构满足
`stream(model, context, resolvedOptions)` 即可。

### 请求

```ts
interface ModelConfig {
  readonly provider: string;
  readonly model: string;
}

interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}

interface StreamOptions {
  readonly timeout?: number;       // 秒，默认 120
  readonly maxTokens?: number;     // 默认 8000
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  readonly signal?: AbortSignal;
}

interface ModelRuntime {
  stream(
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk>;

  complete(
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): Promise<AssistantMessage>;
}
```

### Message

```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
  readonly model: string;
  readonly usage?: TokenUsage;
  readonly stopReason: StopReason;
  readonly errorMessage?: string;
  readonly latencyMs: number;
}

interface ToolResultMessage<TDetails = unknown> {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly details?: TDetails;
  readonly isError?: boolean;
}

type ContentBlock = TextBlock | ThinkingBlock | ToolCall;

interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

interface ThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature?: string;
}

type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
```

### Tool

```ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
}

interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

`Tool` 只有模型可见的 schema。agent 的 `AgentTool` 实现它并增加校验和执行。
`ToolCall` 也是一种 `ContentBlock`；进入 agent loop 后会转换为 `AgentToolCall`。

### `content` 与 `details` 的分层

`ToolResultMessage<TDetails>` 是一条内部消息，同时携带两层事实：

```text
content  → 模型可见的文本（写入 Provider wire payload）
details  → 程序可见的结构化数据（留在 Session / 调用方 / 内存）
```

Provider adapter 只投影对应 Provider 需要的字段，`details` 永远不进网络请求：

```ts
// anthropic 投影：只取 content 和协议字段
messages.push({ role: "user", content: [
  { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
] });
```

因此凡是模型下一轮需要知道的状态都必须出现在 `content`；`details` 只提供同一事实的
结构化表示，供 Session 和其他程序逻辑消费。

### Stream chunk

一个 `StreamChunk` 是一次 provider 响应中的一个片段，由 Agent 直接消费；它不是通过
`Events` 注册、发布或观察的运行事实，只是从 provider 到 agent 的数据传输。

```ts
type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argumentsDelta: string }
  | { type: "toolcall_end"; toolCall: ToolCall }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message: AssistantMessage };
```

前五种是增量片段；`done` 和 `error` 是终止块，提供完整 assistant message。每一轮 Stream
必须以 `done` 或 `error` 结束；`error` 块的 message 带 `stopReason: "error"` 和
`errorMessage`。agent loop 直接消费该流，在缺少终止块时让 Run 失败，不会发布没有完整消息的
`agent/turn-end`。

## 使用范围与包边界

全部 18 个公开导出的使用范围如下：

| 导出 | 建议范围 |
|---|---|
| `createModelRuntime`, `ProviderConfig` | 应用组合根配置 ai 能力 |
| `ModelRuntime` | provider 路由和请求能力；由 Harness 或应用组合层持有 |
| `ModelConfig` | 一次请求的模型选择；agent 和模型选择界面可直接使用 |
| `Context`, `StreamChunk` | ai 调用边界；agent 内部消费，不继续向上透传 |
| `StreamOptions` | ai 直接调用选项 |
| `Message` | 传入 agent 后使用领域名 `AgentMessage` |
| `UserMessage`, `AssistantMessage`, `ToolResultMessage` | ai 消息协议成员 |
| `ContentBlock`, `TextBlock`, `ThinkingBlock` | assistant 内容协议 |
| `Tool` | ai schema；相邻 agent 的 `AgentTool` 实现它 |
| `ToolCall` | ai 调用协议；进入 agent 后转换为 `AgentToolCall` |
| `StopReason`, `TokenUsage` | `AssistantMessage` 的元数据 |

“不继续向上透传”不是禁止导入，而是优先使用离调用者最近的包类型。这样 ai 协议变化
通常只需要修改相邻 agent 翻译层。

## 内部接口与依赖

`Adapter`、`ResolvedOptions`、`Environment`、`lazyAdapter` 以及三个具体 adapter
没有从 `ai/index.ts` 导出，不属于稳定包接口。

依赖：

- `@anthropic-ai/sdk`、`openai`、`@google/genai`
- `typebox`
- 仅供 core 内部使用的 `core/util`（错误与 timeout helper）

本包不依赖 agent、harness 或 CLI。
