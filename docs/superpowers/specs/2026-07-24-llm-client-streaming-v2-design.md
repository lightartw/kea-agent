# LLM Client Streaming v2

**Date:** 2026-07-24
**Reference:** Pi `ai` package streaming protocol

## Summary

Redesign streaming protocol and message types following Pi's content-block model. Goal: distinguish thinking/text/toolcall in stream events so the CLI can render each differently.

Five changes:
1. Split `Message` into 3 discriminated types; `AssistantMessage.content` becomes `ContentBlock[]`
2. Replace `LLMResponse` with `AssistantMessage` — the stream's final output IS the history message
3. Replace `LLMStreamEvent` (2 variants) with `AssistantMessageEvent` (7 variants)
4. Delete `LLMClient.invoke()` — `stream()` consumed to completion replaces it
5. `AgentEvent` gains `thinking_delta`, `toolcall_start`, `toolcall_delta`, `toolcall_end`

## Section 1 — Content Blocks

### Before

```ts
interface Message {
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: readonly ToolCall[];
  toolCallId?: string;
  name?: string;
}
```

All roles share one interface. Fields are mutually exclusive across roles.

### After

```ts
// Each assistant message is an ordered list of typed blocks
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface TextBlock { readonly type: "text"; readonly text: string }
export interface ThinkingBlock { readonly type: "thinking"; readonly thinking: string; readonly signature?: string }
export type ToolCallBlock = ToolCall;  // existing ToolCall { type: "toolCall", id, name, arguments }

// Three separate message types
export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
  readonly model: string;
  readonly usage?: TokenUsage;
  readonly stopReason: StopReason;
  readonly errorMessage?: string;
  readonly latencyMs: number;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

`StopReason` replaces `FinishReason` — adds `"error"` and `"aborted"`:

```ts
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

### Why

- CLI rendering drives this: thinking → grey, text → white, toolCall → yellow. `ContentBlock[]` makes it trivial — iterate blocks, render by type.
- Discriminated union: TypeScript narrows each variant without optional-field checks.
- `model`/`usage`/`stopReason`/`latencyMs` live on `AssistantMessage` — no separate wrapper type, no information loss.

## Section 2 — Streaming Events

### Before (2 variants)

```ts
type LLMStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "response_done"; response: LLMResponse };
```

### After (7 variants)

```ts
export type AssistantMessageEvent =
  | { type: "text_delta";          text: string }
  | { type: "thinking_delta";      thinking: string }
  | { type: "toolcall_start";      id: string; name: string }
  | { type: "toolcall_delta";      id: string; argumentsDelta: string }
  | { type: "toolcall_end";        toolCall: ToolCall }
  | { type: "done";                message: AssistantMessage }
  | { type: "error";               message: AssistantMessage };
```

### Event lifecycle for one streamed response

```
thinking_delta*       (zero or more)
text_delta*           (zero or more)
(toolcall_start → toolcall_delta* → toolcall_end)*   (zero or more per tool call)
done | error          (exactly one, terminal)
```

### Why each event

| Event | Trigger (adapter level) | CLI renders as |
|---|---|---|
| `thinking_delta` | OpenAI: `delta.reasoning_content`; Anthropic: `content_block_delta` for thinking | Grey text |
| `text_delta` | OpenAI: `delta.content`; Anthropic: `content_block_delta` for text | White text |
| `toolcall_start` | Adapter has id + name, arguments not yet complete | Yellow "calling tool…" |
| `toolcall_delta` | Chunk of tool call JSON arguments | Appends to tool call display |
| `toolcall_end` | All arguments received, JSON.parse succeeded | Show complete call with args |
| `done` | Stream ended normally (`finish_reason` received + usage) | Turn complete, execute tool calls |
| `error` | SDK threw or stream errored | Red error message, no tool execution |

## Section 3 — Delete `invoke()`

### Before

```ts
interface LLMClient {
  invoke(context: Context, options?): Promise<LLMResponse>;
  stream(context: Context, options?): AsyncIterable<LLMStreamEvent>;
}
```

### After

```ts
interface LLMClient {
  stream(context: Context, options?): AsyncIterable<AssistantMessageEvent>;
}
```

Non-streaming call = consume stream to completion, take `done.message`:

```ts
async function invoke(client: LLMClient, ctx: Context): Promise<AssistantMessage> {
  for await (const event of client.stream(ctx)) {
    if (event.type === "done") return event.message;
    if (event.type === "error") return event.message;
  }
  throw new Error("stream ended without done/error");
}
```

### Why

- Single code path per adapter — no `invoke()` implementation duplication
- Test mocks only need to implement `stream()`
- Natural: every LLM API call is a stream; non-streaming is just not rendering the intermediate events

## Section 4 — AgentEvent Changes

### Before

```ts
type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  | { type: "turn_end"; response: LLMResponse };
```

### After

```ts
type AgentEvent =
  | { type: "text_delta";      text: string }
  | { type: "thinking_delta";  thinking: string }             // ← new
  | { type: "toolcall_start";  id: string; name: string }     // ← new
  | { type: "toolcall_delta";  id: string; argumentsDelta: string }  // ← new
  | { type: "toolcall_end";    toolCall: ToolCall }           // ← new
  | { type: "tool_start";      call: ToolCall }
  | { type: "tool_end";        call: ToolCall; result: ToolResult }
  | { type: "turn_end";        message: AssistantMessage };
```

Note: `toolcall_*` events come from the LLM stream (provider → model request). `tool_start`/`tool_end` come from agent-level tool execution. The latter only fire after `turn_end` (when agent-loop executes tools).

### Why

- `thinking_delta`, `toolcall_start`, `toolcall_delta`, `toolcall_end` are forwarded from `AssistantMessageEvent` so CLI can render them
- `turn_end` now carries `AssistantMessage` (not `LLMResponse`) — same object that enters history

## Section 5 — TokenUsage + StopReason update

### TokenUsage

```ts
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
```

Unchanged from current. Lives on `AssistantMessage.usage`.

### StopReason

```ts
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

Replaces `FinishReason`. Adds `"error"` and `"aborted"` (Pi alignment; needed for stream error events).

## File Impact Summary

| File | Change |
|---|---|
| `llm-client/types.ts` | 重写 — ContentBlock/AssistantMessage/discriminated Message/AssistantMessageEvent/StopReason; 删除 LLMResponse/FinishReason |
| `llm-client/index.ts` | 导出更新 — 删 LLMResponse，加 AssistantMessage/StopReason |
| `llm-client/adapters/*.ts` | `stream()` yield 7 种新事件，删 `invoke()`，thinking/toolcall 适配 |
| `llm-client/factory.ts` | 返回类型更新 |
| `agent/agent-loop.ts` | 消费新事件，text_delta/thinking_delta 透传，toolcall 积累，done 时 push AssistantMessage 进 history |
| `agent/agent.ts` | Message 类型变化，systemPrompt 沿用 |
| `agent/types.ts` | AgentEvent 加 4 个变体，turn_end 改 AssistantMessage |
| `agent/hooks/types.ts` | Message 导入更新 |
| `harness/session/*.ts` | 新 Message 格式持久化 |
| `harness/types.ts` | SessionStore 类型更新 |
| `cli/render.ts` | 按 ContentBlock 类型渲染 |
| `cli/frontend.ts` | 新增事件类型渲染 |
| `main.ts` | 类型引用更新 |
| Tests | Message 构造改为 discriminated union; mock stream yield 新事件; 删 invoke 测试 |

## Non-goals

- `contentIndex` (Pi's per-block tracking) — Kea uses yield order, no index needed
- `start` event — agent-loop knows message boundaries
- `text_start`/`text_end`/`thinking_start`/`thinking_end` — first delta of a type IS its start, next different type is its end
- Image/multimodal content blocks — text + thinking + toolCall only
- Partial tool call rendering in CLI — event exists, renderer can add later
