# llm-client

Thin LLM transport layer. Stream-only. Knows nothing about agent concepts — no execute, no validate, no hooks.

## Type tiers

llm-client exports two categories of types. Know which is which so you don't import transport internals from the wrong layer.

### Tier 1 — Global data types

Used by **every** package (`agent`, `harness`, `cli`, `session`). These are just data — they describe what the model said and what tools it called. Any module can import them.

| Type | Description |
| --- | --- |
| `Message` | Discriminated union: `UserMessage \| AssistantMessage \| ToolResultMessage` |
| `UserMessage` | `{ role: "user", content: string }` |
| `AssistantMessage` | `{ role: "assistant", content: ContentBlock[], model, usage?, stopReason, errorMessage?, latencyMs }` |
| `ToolResultMessage` | `{ role: "tool", toolCallId, name, content, isError? }` |
| `Tool` | Thin tool schema: `{ name, description, parameters: TObject }` |
| `ToolCall` | Model's tool request: `{ type: "toolCall", id, name, arguments }` |

### Tier 2 — Transport types

Used only by **llm-client adapters** and **agent-loop**. Harness and CLI should never import these directly — they get events through `AgentEvent` instead.

| Type | Who uses it |
| --- | --- |
| `LLMClient` | Factory creates it, `agent-loop` calls `stream()` |
| `Context` | Built by `agent-loop`, consumed by adapter `stream()` |
| `AssistantMessageEvent` | 7 events yielded by adapters, consumed by `agent-loop` → translated to `AgentEvent` |
| `ContentBlock` | Internal to `AssistantMessage.content` — exported because `AssistantMessage` references it |
| `TextBlock` | `{ type: "text", text }` |
| `ThinkingBlock` | `{ type: "thinking", thinking, signature? }` |
| `LLMOptions` | Timeout, maxTokens, etc. Configured via factory, overridden per-call |
| `LLMConfig` | Factory internal — model + apiKey + baseUrl + options |
| `StopReason` | `"stop" \| "length" \| "toolUse" \| "error" \| "aborted"` |
| `TokenUsage` | `{ inputTokens, outputTokens, totalTokens }` — carried inside `AssistantMessage.usage` |

## Public API

```ts
// Tier 1 — global data types
export type {
  Message, UserMessage, AssistantMessage, ToolResultMessage,
  Tool, ToolCall,
} from "./types.js";

// Tier 2 — transport types (needed by agent-loop and factory consumers)
export type {
  LLMClient, Context, AssistantMessageEvent,
  ContentBlock, TextBlock, ThinkingBlock,
  StopReason, TokenUsage,
} from "./types.js";

export { createLLMClient } from "./factory.js";
```

## Usage

```ts
import { createLLMClient } from "./llm-client/index.js";
import type { Context, AssistantMessage } from "./llm-client/types.js";

const client = await createLLMClient();

const ctx: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

for await (const event of client.stream(ctx)) {
  switch (event.type) {
    case "text_delta":       break; // white  text
    case "thinking_delta":   break; // grey   reasoning
    case "toolcall_start":   break; // yellow tool name
    case "toolcall_delta":   break; // stream arguments
    case "toolcall_end":     break; // complete ToolCall
    case "done":             break; // event.message is AssistantMessage
    case "error":            break; // event.message.stopReason === "error"
  }
}
```

## Internal

| Type | Where |
|---|---|
| `LLMOptions` | `Partial<LLMOptions>` in `stream()` and `createLLMClient()` |
| `LLMConfig` | Factory internal — resolved from env + options |
| `resolveOptions` | Exported only for testing — merges defaults with user overrides |
