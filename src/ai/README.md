# ai

`ai` 是 LLM 传输层：它把不同 provider 的一次流式调用统一为 `StreamFn`。
调用者每次传入完整上下文；本包不保存历史、不执行工具，也不控制 agent loop。

## 用法

```ts
import { createStreamFn, type Context } from "./ai/index.js";

const { stream, defaultModel } = createStreamFn();
const context: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of stream(defaultModel, context)) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "error") console.error(event.message.errorMessage);
}
```

一次 `StreamFn` 调用是一个 LLM turn。tool call 只是输出协议；调用者执行工具后，
把 `ToolResultMessage` 加入下一次调用的 `Context.messages`。

## Provider 与模型切换

`createStreamFn()` 找出所有已配置 provider，为它们创建 lazy adapter，并返回同一个
路由函数。内置配置如下：

| Provider | API key | 可选 base URL |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` |

`MODEL_ID` 必须提供。只有一家 provider 时自动作为默认；多家时必须设置
`DEFAULT_PROVIDER`。默认项只决定 `defaultModel`，不限制其他已配置 provider。

```ts
const { stream, defaultModel } = createStreamFn({
  env: {
    ANTHROPIC_API_KEY: "...",
    OPENAI_API_KEY: "...",
    DEFAULT_PROVIDER: "anthropic",
    MODEL_ID: "claude-sonnet-5",
  },
});

// 切换 model/provider 不需要重建 stream。
for await (const event of stream(
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

const { stream } = createStreamFn({ providers: [deepseek] });
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

function createStreamFn(options?: {
  providers?: ProviderConfig[];
  env?: Readonly<Record<string, string | undefined>>;
}): {
  stream: StreamFn;
  defaultModel: ModelConfig;
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

type StreamFn = (
  model: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<AssistantMessageEvent>;
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

interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
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

### Stream event

```ts
type AssistantMessageEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; id: string; name: string }
  | { type: "toolcall_delta"; id: string; argumentsDelta: string }
  | { type: "toolcall_end"; toolCall: ToolCall }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message: AssistantMessage };
```

前五种是增量事件；`done` 和 `error` 提供完整 assistant message。agent loop
直接消费该事件流，但对更高层输出自己的 `AgentEvent`。

## 使用范围与包边界

全部 18 个公开导出的使用范围如下：

| 导出 | 建议范围 |
|---|---|
| `createStreamFn`, `ProviderConfig` | 应用组合根配置 ai 能力 |
| `StreamFn` | ai 核心能力；直接注入相邻 agent 层 |
| `ModelConfig` | ai 的模型句柄；agent 和模型选择界面可直接使用 |
| `Context`, `AssistantMessageEvent` | ai 调用边界；agent 内部消费，不继续向上透传 |
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
- 项目内部的 `utils/timeout`

本包不依赖 agent、harness 或 CLI。
