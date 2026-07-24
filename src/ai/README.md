# ai

AI transport layer. Stateless, stream-only. Provider routing is transparent to callers.

## Core idea

One function signature for all LLM calls. The caller never knows which provider
or adapter is handling the request.

```ts
import type { StreamFn } from "./ai/types.js";

// StreamFn = (model, context, options?) => AsyncIterable<AssistantMessageEvent>
```

Model is a request parameter, not a constructor parameter. Same adapter handles
any model on its provider. Switch provider by changing `model.provider` —
the factory's internal pool routes to the correct adapter.

## Exports

### Global data types (any package can import)

```ts
Tool              // { name, description, parameters: TObject }
ToolCall          // { type: "toolCall", id, name, arguments }
Message           // UserMessage | AssistantMessage | ToolResultMessage
UserMessage       // { role: "user", content: string }
AssistantMessage  // { role: "assistant", content: ContentBlock[], model, stopReason, ... }
ToolResultMessage // { role: "tool", toolCallId, name, content, isError? }
```

These are pure data — they describe what the model said and what tools it called.
No behavior, no transport details.

### Transport types (agent-loop boundary)

```ts
ModelConfig       // { provider: string, model: string }  — routing key for each request
StreamFn          // (model, context, options?) => AsyncIterable<AssistantMessageEvent>
StreamOptions     // { timeout, maxTokens, temperature?, topP?, stop?, signal? }
Context           // { systemPrompt?, messages, tools? }
AssistantMessageEvent  // 7 discriminated events: text_delta, thinking_delta, toolcall_*, done, error
```

### Factory

```ts
createStreamFn(options?) → StreamFn
```

Auto-detects configured providers from environment variables. Returns a `StreamFn`
closure that pools adapters lazily.

```ts
const stream = createStreamFn();
// stream({ provider: "anthropic", model: "claude-sonnet-5" }, ctx);
// stream({ provider: "anthropic", model: "claude-opus-4-8" }, ctx);  // same adapter
// stream({ provider: "openai", model: "gpt-4o" }, ctx);              // different adapter
```

## Usage

```ts
import { createStreamFn } from "./ai/index.js";
import type { Context, ModelConfig, AssistantMessageEvent } from "./ai/types.js";

const stream = createStreamFn();

const model: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5" };
const ctx: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of stream(model, ctx)) {
  switch (event.type) {
    case "text_delta":       break; // white text
    case "thinking_delta":   break; // grey reasoning
    case "toolcall_start":   break; // yellow tool name
    case "toolcall_delta":   break; // stream arguments
    case "toolcall_end":     break; // complete ToolCall
    case "done":             break; // event.message is AssistantMessage
    case "error":            break; // event.message.stopReason === "error"
  }
}
```

## Custom providers

Register additional providers at factory time. OpenAPI-compatible APIs
(Kimi, DeepSeek, GLM) reuse `OpenAIAdapter` with a different baseUrl.

```ts
import { createStreamFn } from "./ai/index.js";
import { OpenAIAdapter } from "./ai/adapters/openai.js";

const stream = createStreamFn({
  providers: [{
    id: "kimi",
    envApiKey: "KIMI_API_KEY",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    createAdapter: (apiKey, baseUrl) => new OpenAIAdapter(apiKey, baseUrl),
  }],
  env: process.env,
});

stream({ provider: "kimi", model: "moonshot-v1-8k" }, ctx);
```

## Adapter contract

Adapters are stateless. Constructor takes auth, `stream()` takes model.

```ts
interface Adapter {
  stream(model: string, context: Context, options?: Partial<StreamOptions>): AsyncIterable<AssistantMessageEvent>;
}
```

Constructor signature by provider:
```ts
new AnthropicAdapter(apiKey: string, baseUrl?: string | null)
new OpenAIAdapter(apiKey: string, baseUrl?: string | null)
new GeminiAdapter(apiKey: string, baseUrl?: string | null)
```

## Design rationale

**Why `StreamFn` instead of `LLMClient` class.** A function is the interface.
Pi uses `StreamFn = (model, ctx, options) => stream`. No class wrapping needed —
the caller sees a function signature, the factory returns a closure. Adding
providers is adding entries to a registry, not changing an interface.

**Why model is a request parameter, not a constructor parameter.** Every major
SDK (OpenAI, Anthropic, Google, Vercel AI) puts model on the request, not the
client. A client represents a provider connection (auth + endpoint). Switching
models on the same provider should not require a new client.

**Why provider routing is in the factory, not in agent.** Agent sees `StreamFn` —
a single function. It never knows about providers, adapters, or API keys.
Switching from Claude to GPT is changing `model.provider` on the next call.
The factory's internal `Map<provider, Adapter>` handles the rest.

**Why adapters are not exported from index.** They are internal implementation
details. Other modules import types from `ai/types.js`, call `createStreamFn()`,
and interact only with `StreamFn`. Custom providers import adapters directly
from `ai/adapters/`.

## Internal (not exported from index)

`ProviderConfig` — registry entry for one provider. Exported from factory for
custom registration but not re-exported from index.

Adapters are not exported from index. Import them directly only when registering
a custom provider that reuses an existing adapter implementation.
