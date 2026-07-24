# llm-client

Thin LLM transport layer. Stream-only. Knows nothing about agent concepts — no execute, no validate, no hooks.

## Public API (15 type exports + 1 function)

```ts
export type {
  AssistantMessage, AssistantMessageEvent, ContentBlock, Context,
  LLMClient, Message, StopReason, TextBlock, ThinkingBlock,
  Tool, ToolCall, TokenUsage, ToolResultMessage, UserMessage,
} from "./types.js";
export { createLLMClient } from "./factory.js";
```

### Core types

**`Tool`** — LLM-facing tool definition (name + schema). Pure data.
```ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;  // TypeBox schema
}
```
Agent layer extends via `AgentTool implements Tool`, adding `validate()` + `execute()`.

**`ToolCall`** — Model requests to run one tool.
```ts
interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
```

**`ContentBlock`** — One element inside an assistant message. Order = LLM output order.
```ts
type ContentBlock = TextBlock | ThinkingBlock | ToolCall;

interface TextBlock     { type: "text";      text: string }
interface ThinkingBlock { type: "thinking";  thinking: string; signature?: string }
```
`ToolCall` itself is a `ContentBlock` variant.

**`Message`** — Discriminated union. No optional fields — each role has its own type.
```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage       { role: "user";       content: string }
interface ToolResultMessage { role: "tool";        toolCallId: string; name: string; content: string; isError?: boolean }
interface AssistantMessage  { role: "assistant";   content: ContentBlock[]; model: string; usage?: TokenUsage; stopReason: StopReason; errorMessage?: string; latencyMs: number }
```

**`AssistantMessageEvent`** — Adapter stream yields 7 event types.
```ts
type AssistantMessageEvent =
  | { type: "text_delta";       text: string }
  | { type: "thinking_delta";   thinking: string }
  | { type: "toolcall_start";   id: string; name: string }
  | { type: "toolcall_delta";   id: string; argumentsDelta: string }
  | { type: "toolcall_end";     toolCall: ToolCall }
  | { type: "done";             message: AssistantMessage }    // terminal
  | { type: "error";            message: AssistantMessage };   // terminal
```

Event lifecycle per streamed response:
```
thinking_delta*                                         (zero or more)
text_delta*                                             (zero or more)
(toolcall_start → toolcall_delta* → toolcall_end)*     (zero or more per tool)
done | error                                            (exactly one)
```

**`Context`** — One LLM request.
```ts
interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly Tool[];
}
```

**`LLMClient`** — Stream-only. No `invoke()` — consume `done` for non-streaming.
```ts
interface LLMClient {
  stream(context: Context, options?: Partial<LLMOptions>): AsyncIterable<AssistantMessageEvent>;
}
```

**`StopReason`** — How the stream ended.
```ts
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

### Factory

**`createLLMClient(options?, env?)`** — Auto-detects provider from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`).

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
    case "text_delta":       /* white  */ break;
    case "thinking_delta":   /* grey   */ break;
    case "toolcall_start":   /* yellow */ break;
    case "toolcall_delta":   /* stream args */ break;
    case "toolcall_end":     /* complete */ break;
    case "done":             /* final message = event.message */ break;
    case "error":            /* event.message.stopReason === "error" */ break;
  }
}
```

## Internal (not exported)

| Type | Consumed via |
|---|---|
| `LLMOptions` | `Partial<LLMOptions>` in `stream()` and `createLLMClient()` |
| `LLMConfig` | Factory internal — resolved from env + options |
| `TokenUsage` | Exported for type annotation, but only carried inside `AssistantMessage.usage` |
