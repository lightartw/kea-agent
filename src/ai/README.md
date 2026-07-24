# ai

LLM transport. Stateless. Pure data types + one function.

Knows nothing about tools, hooks, sessions, or presentation.

## Exports

### `createStreamFn` — [factory.ts](factory.ts)

Returns `{ stream, defaultModel }`. Reads provider config from env, returns a `StreamFn`
that routes by `model.provider` through a lazy adapter pool.

```ts
import { createStreamFn } from "./ai/factory.js";

const { stream, defaultModel } = createStreamFn();
// defaultModel: { provider: "anthropic", model: "claude-sonnet-5" }

for await (const event of stream(defaultModel, ctx)) {
  // text_delta | thinking_delta | toolcall_start | toolcall_delta | toolcall_end | done | error
}
```

One `StreamFn` handles all providers. Switch model by changing `model.provider`.

Custom provider:

```ts
const { stream } = createStreamFn({
  providers: [{ id: "deepseek", envApiKey: "DEEPSEEK_API_KEY",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    createAdapter: (key, url) => new OpenAIAdapter(key, url) }],
});
```

### `StreamFn` — [types.ts](types.ts)

```ts
type StreamFn = (
  model: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<AssistantMessageEvent>;
```

### Global data types — [types.ts](types.ts)

Imported by `agent`, `harness`, and `cli`. Pure data, no behavior.

```ts
ModelConfig       // { provider: string, model: string }
StreamOptions     // { timeout?, maxTokens?, temperature?, topP?, stop?, signal? }

// Messages — discriminated by role
Message           // UserMessage | AssistantMessage | ToolResultMessage
UserMessage       // { role: "user", content: string }
AssistantMessage  // { role: "assistant", content: ContentBlock[], model, stopReason, usage?, errorMessage?, latencyMs }
ToolResultMessage // { role: "tool", toolCallId, name, content, isError? }

// Content blocks
ContentBlock      // TextBlock | ThinkingBlock | ToolCall
TextBlock         // { type: "text", text: string }
ThinkingBlock     // { type: "thinking", thinking: string, signature?: string }

// Tool types
Tool              // { name, description, parameters: TObject }
ToolCall          // { type: "toolCall", id, name, arguments }

StopReason        // "stop" | "length" | "toolUse" | "error" | "aborted"
TokenUsage        // { inputTokens, outputTokens, totalTokens }
```

### Transport types — [types.ts](types.ts)

Only `agent` uses these directly.

```ts
AssistantMessageEvent  // 7-variant discriminated union
Context                // { systemPrompt?, messages: readonly Message[], tools?: readonly Tool[] }
```

`AssistantMessageEvent`:

```ts
| { type: "text_delta";     text: string }
| { type: "thinking_delta"; thinking: string }
| { type: "toolcall_start"; id: string; name: string }
| { type: "toolcall_delta"; id: string; argumentsDelta: string }
| { type: "toolcall_end";   toolCall: ToolCall }
| { type: "done";           message: AssistantMessage }
| { type: "error";          message: AssistantMessage }  // stopReason "error" | "aborted"
```

`done` and `error` are terminal events carrying the completed `AssistantMessage`.

## Usage

Minimal:

```ts
import { createStreamFn } from "./ai/factory.js";
import type { Context, ModelConfig } from "./ai/types.js";

const { stream, defaultModel } = createStreamFn();
const ctx: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of stream(defaultModel, ctx)) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

With tools:

```ts
const ctx: Context = {
  systemPrompt: "You have tools.",
  messages: [...],
  tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
};
```

## Internals

Types not exported from index but used by adapters.

### `Adapter` — [factory.ts](factory.ts)

Adapter interface. Adapters implement this, not exported from index.

```ts
interface Adapter {
  stream(model: string, context: Context, options: ResolvedOptions): AsyncIterable<AssistantMessageEvent>;
}
```

### `ResolvedOptions` — [factory.ts](factory.ts)

Options after defaults are filled. `timeout` and `maxTokens` are always present.

```ts
interface ResolvedOptions {
  timeout: number;     // default 120
  maxTokens: number;   // default 8000
  temperature?: number;
  topP?: number;
  stop?: readonly string[];
  signal?: AbortSignal;
}
```

### `ProviderConfig` — [factory.ts](factory.ts)

Provider registration descriptor. Not exported from index.

```ts
interface ProviderConfig {
  id: string;           // matched by model.provider
  envApiKey: string;    // env var holding the API key
  envBaseUrl?: string;  // optional custom base URL env var
  defaultBaseUrl?: string;
  createAdapter: (apiKey: string, baseUrl?: string | null) => Adapter;
}
```

### Adapters — [adapters/](adapters/)

Three adapters implement `Adapter`:

- `AnthropicAdapter` — Anthropic Messages streaming
- `OpenAIAdapter` — OpenAI Chat Completions streaming, compatible with DeepSeek, Kimi, etc.
- `GeminiAdapter` — Google Gemini generateContent streaming

Each wraps a provider SDK. Defaults (`timeout: 120`, `maxTokens: 8000`) are applied by
factory before the adapter receives them — adapters never set their own defaults.

## Dependencies

No imports from other Kea packages (`agent`, `harness`, `cli`). Only external SDKs:
`@anthropic-ai/sdk`, `openai`, `@google/genai`, and `typebox`.
