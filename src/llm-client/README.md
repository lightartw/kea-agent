# llm-client

Thin LLM transport layer. Knows nothing about agent-level concepts — no execute, no validate, no hooks. Just types for talking to LLM providers.

## Public API (7 names)

`index.ts` exports exactly these:

```ts
export type { Context, LLMClient, LLMResponse, Message, Tool, ToolCall } from "./types.js";
export { createLLMClient } from "./factory.js";
```

### Types

**`Tool`** — LLM-facing tool definition. Pure data, no methods.
```ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;  // TypeBox schema
}
```
The agent layer extends this via `AgentTool implements Tool`, adding `validate()` + `execute()`.

**`ToolCall`** — The model's request to run one tool.
```ts
interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

**`Message`** — One turn in the conversation. No `"system"` role (system prompt lives in `Context`).
```ts
interface Message {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}
```

**`Context`** — Everything needed for one LLM request.
```ts
interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}
```

**`LLMClient`** — Provider-agnostic interface.
```ts
interface LLMClient {
  invoke(context: Context, options?: Partial<LLMOptions>): Promise<LLMResponse>;
  stream(context: Context, options?: Partial<LLMOptions>): AsyncIterable<LLMStreamEvent>;
}
```

**`LLMResponse`** — Normalized response from any provider.
```ts
interface LLMResponse {
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly finishReason: FinishReason;
}
```

### Factory

**`createLLMClient(options?, env?)`** — Auto-detects provider from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`), returns a ready-to-use `LLMClient`.

## Usage

```ts
import { createLLMClient } from "./llm-client/index.js";
import type { Context, Message } from "./llm-client/types.js";

const client = await createLLMClient({ model: "claude-sonnet-4-5" });

const ctx: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of client.stream(ctx)) {
  if (event.type === "text_delta") console.log(event.text);
}
```

## Internal (not exported)

These exist in `types.ts` but are NOT in `index.ts`. You can still `import type` them from `./types.js` when needed.

**`LLMOptions`** — Passed as `Partial<LLMOptions>` to `createLLMClient()` and to `client.stream()` / `client.invoke()` for per-call overrides.

```ts
interface LLMOptions {
  readonly timeout: number;       // seconds, default 120
  readonly maxTokens: number;     // default 8000
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}
```

**`LLMConfig`** — Resolved by the factory from env + options. Used to construct concrete adapters.

```ts
interface LLMConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly options: LLMOptions;
}
```

**Other internal types:**

| Type | Consumed via |
|---|---|
| `FinishReason` | `LLMResponse.finishReason` |
| `TokenUsage` | `LLMResponse.usage` |
| `LLMStreamEvent` | `for await` type inference from `stream()` return type |
