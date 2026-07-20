# Core Simplification and Streaming Design

**Date:** 2026-07-21

## Summary

Kea Agent is still establishing its basic architecture. The current TypeScript
implementation was migrated with public-library-level validation, cancellation,
lazy loading, and stream cleanup guarantees. Those guarantees obscure the core
Agent flow and are premature for the current stage.

This change simplifies the code around the behavior Kea needs now:

- one non-streaming LLM operation and one streaming LLM operation, both with
  optional tools;
- a streamed user experience that executes tool calls only after their arguments
  are complete;
- a small Agent event stream for decoupling orchestration from the CLI;
- a focused Tool Registry and a tools-owned default factory;
- timeout support without exposing caller cancellation through every module;
- runtime validation only at genuinely untrusted seams.

The design borrows Pi's separation between provider stream events, Agent events,
and durable messages, but deliberately omits Pi's broader event protocol,
extension hooks, partial tool rendering, steering, parallel execution, and
framework infrastructure.

## Goals

- Make the basic Agent flow readable from end to end.
- Stream assistant text to the user while retaining tool calling.
- Keep non-streaming LLM invocation for callers that want a complete response.
- Keep provider and tool timeouts.
- Remove caller-controlled cancellation until it has a separately approved
  product design.
- Remove validation and abstractions that exist only for hypothetical external
  callers, incorrect TypeScript implementations, or extreme configuration.
- Keep provider response validation and tool argument validation because those
  values cross untrusted seams.
- Keep the CLI, Agent turn, LLM adapters, and tools independently understandable.

## Non-goals

- A TUI.
- A general event bus or `EventEmitter`-based subscription system.
- Thinking, image, reasoning, or multimodal stream events.
- Streaming partial tool arguments to the UI.
- Streaming partial tool execution output.
- Parallel tool execution.
- Caller cancellation, Ctrl+C propagation, or preservation of abort reasons.
- A public plugin or third-party Adapter framework.
- Dynamic tool discovery or reload behavior beyond explicit Registry
  registration and unregistration.
- Moving the system prompt out of `Message` in this change. That may happen when
  an explicit Agent context is designed.

## Design Principles

Kea currently optimizes for a small internal application, not a stable public
framework. TypeScript contracts are trusted for internal caller-owned data.
Runtime checks remain where data enters from a provider or an LLM.

Events and messages are different concepts:

- a `Message` is durable conversation history and is sent to future model calls;
- an event is an ephemeral notification about execution progress and is consumed
  by a UI.

One streamed provider response becomes one assistant message, regardless of how
many text delta events it produced.

## Target Structure

```text
src/
├── index.ts
├── main.ts
├── agent-turn.ts
├── utils/
│   └── timeout.ts
├── llm-client/
│   ├── index.ts
│   ├── types.ts
│   ├── factory.ts
│   ├── errors.ts
│   └── adapters/
│       ├── anthropic.ts
│       ├── openai.ts
│       └── gemini.ts
└── tools/
    ├── index.ts
    ├── base.ts
    ├── registry.ts
    ├── factory.ts
    └── builtin/
        └── bash.ts
```

`src/main.ts` owns terminal input and event rendering. `src/agent-turn.ts` owns
one user turn, including repeated model calls and tool execution. The LLM module
owns provider-neutral model contracts and provider translation. The tools module
owns executable tools, Registry behavior, built-in tools, and default tool
assembly. Timeout machinery remains a shared utility because both providers and
tools consume it.

## Messages

The existing discriminated union remains:

```ts
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;
```

These are TypeScript interfaces, not runtime classes. A single class with a
`role` field and many optional properties would admit invalid combinations and
would require more runtime checking.

The system prompt stays represented as a system message for now. A future Agent
context may move it to a separate `systemPrompt` field without changing the
decision to use discriminated message types.

## Unified Tool Schema

`Tool` is Kea's single executable tool abstraction. It owns the tool name,
description, TypeBox parameter schema, timeout, and execution implementation.
There is no second `ToolDefinition` model.

`Tool.toSchema()` serializes the model-visible portion of a Tool to the existing
OpenAI function-tool shape:

```ts
export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}
```

This `ToolSchema` is Kea's one common exchange format between the tools and LLM
modules. It is a serialized view of `Tool`, not a separate domain abstraction.
The Registry returns `ToolSchema[]`; LLM calls accept `ToolSchema[]`.

Each Adapter owns conversion from that schema to its provider shape:

```text
OpenAI ToolSchema
├── Anthropic: { name, description, input_schema }
├── OpenAI:    passed through unchanged
└── Gemini:    { functionDeclarations: ... }
```

`ToolCall` remains an LLM type because it is produced by a provider response.
`ToolResult` remains a tools type because it describes local execution.

## LLM Client Interface

The existing three-operation Interface becomes two operations:

```ts
export interface LLMClient {
  invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): Promise<LLMResponse>;

  stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent>;
}
```

Both operations support requests with or without tools. `invokeWithTools()` and
the text-only `streamInvoke()` are removed.

`invoke()` uses the provider's non-streaming operation and returns one complete
`LLMResponse`. `stream()` uses the provider's streaming operation and emits:

```ts
export type LLMStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "response_done"; readonly response: LLMResponse };
```

Adapters accumulate provider tool-call fragments internally. They do not expose
partial tool arguments. The final `response_done` event contains the complete
text, normalized usage and finish reason, and complete tool calls.

Every successful `stream()` emits exactly one final `response_done` event and no
events after it. A failed stream throws instead of fabricating a partial final
response.

The common options remain `timeout`, `maxTokens`, `temperature`, `topP`, and
`stop`. `signal` is removed from the public Interface.

Basic domain validation remains for values such as positive `timeout` and
positive integer `maxTokens`. Validation of unknown object keys and impossible
values manufactured by bypassing TypeScript is removed.

## LLM Factory

`createLLMClient()` becomes asynchronous:

```ts
const client = await createLLMClient();
```

It resolves provider configuration synchronously, dynamically imports only the
selected Adapter, constructs the real Adapter, and returns it. It does not return
a lazy proxy.

The following current abstractions are removed:

- `LazyLLMClient`;
- public `AdapterLoader` and `AdapterLoaders` types;
- the injected loader map;
- first-call Promise memoization and concurrent first-call handling.

Provider detection remains limited to exactly one of `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and `GEMINI_API_KEY`. Explicit configuration continues to
override environment configuration. `.env` loading remains solely in the CLI.

## Adapter Responsibilities

Each Adapter independently implements `invoke()` and `stream()` and owns:

1. message translation;
2. tool schema translation;
3. request option translation;
4. provider response normalization;
5. streaming text and tool-call accumulation;
6. timeout integration;
7. provider error translation.

Provider responses remain runtime-checked because SDK responses and compatible
endpoints are external data. Tool arguments must normalize to an object before
they enter the common `ToolCall` contract.

Caller-owned messages, tool schemas, and option object keys are not
revalidated comprehensively at every call. TypeScript owns those contracts in
the current internal-application posture.

## Agent Events and Turn Flow

`agentLoop()` becomes `runAgentTurn()` and moves to `src/agent-turn.ts`.
It is an asynchronous generator:

```ts
export type AgentEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | {
      readonly type: "tool_end";
      readonly call: ToolCall;
      readonly result: ToolResult;
    }
  | { readonly type: "turn_end"; readonly response: LLMResponse };

export function runAgentTurn(
  messages: Message[],
  client: LLMClient,
  registry: ToolRegistry,
): AsyncIterable<AgentEvent>;
```

This is not a global event bus. The caller pulls events in order with
`for await`. A `yield` pauses `runAgentTurn()` until the caller requests the next
event, giving natural ordering and backpressure without subscriptions.

For each model step, `runAgentTurn()`:

1. calls `client.stream(messages, registry.schemas())`;
2. forwards every LLM `text_delta` as an Agent `text_delta`;
3. waits for `response_done` before modifying history or executing tools;
4. appends exactly one normalized assistant message;
5. when there are no tool calls, emits `turn_end` and returns;
6. otherwise executes tool calls sequentially in provider order;
7. emits `tool_start` before each execution;
8. emits `tool_end` with its `ToolResult` after each execution;
9. appends tool result messages; and
10. starts another streamed model step.

The distinction between `response_done` and `turn_end` is deliberate. A provider
response may be complete while the Agent still has tools and another provider
request to run.

Errors are not encoded as additional event variants in the basic design. LLM
failures throw from the async generator. Tool failures become error
`ToolResult`s, emit `tool_end`, and are returned to the model so it can recover.

## CLI

`main.ts` retains the outer human-session loop. That loop has a different
lifetime from the inner Agent turn:

```text
CLI loop:       one iteration per user input
Agent turn:     one iteration per provider response/tool batch
```

The CLI awaits `createLLMClient()`, obtains the default Registry from the tools
factory, and renders Agent events:

- `text_delta`: write text immediately without adding a second final print;
- `tool_start`: show the yellow tool invocation;
- `tool_end`: show the result preview, with error status available;
- `turn_end`: finish the displayed turn and return to the prompt.

No active-run `AbortController` or cancellation propagation remains.

## Tool Module

### Tool

Executable tool parameter schemas are restricted to TypeBox object schemas:

```ts
export abstract class Tool<TParameters extends TObject> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly timeout: number | null;

  abstract execute(
    arguments_: Static<TParameters>,
    timeoutSignal: AbortSignal,
  ): Promise<string>;
}
```

The signal is an internal timeout mechanism, not caller cancellation. It remains
available to implementations such as Bash so a timed-out operation can actually
stop instead of continuing in the background.

Schema ownership uses a simple readonly convention. Construction-time deep
cloning, recursive freezing, and a second export clone are removed.

### ToolResult

`ToolResult` remains structured:

```ts
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
}
```

The error flag now has an immediate consumer in `tool_end` rendering and remains
available for future provider-specific tool-result error metadata.

### ToolRegistry

The Registry Interface is:

```ts
register(tool: Tool<TObject>): void;
unregister(name: string): void;
schemas(): ToolSchema[];
execute(call: ToolCall): Promise<ToolResult>;
```

It keeps:

- registration-order preservation;
- duplicate-name rejection;
- unregistration;
- TypeBox validator compilation;
- LLM argument validation without coercion;
- unknown-tool errors;
- per-tool or default timeout selection;
- expected and unexpected execution error normalization;
- output truncation.

It removes:

- `get()` and `names()`;
- runtime `instanceof Tool` checks;
- manual name and description validation;
- manual JSON Schema root, `properties`, and `required` inspection;
- a minimum result limit tied to the length of `"Error: "`;
- runtime checking for a non-string result from a typed Tool implementation.

### Default Factory

`createToolRegistry()` moves from `main.ts` to `src/tools/factory.ts`:

```ts
export function createToolRegistry(cwd: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new BashTool({ cwd }));
  return registry;
}
```

Future built-in tool assembly belongs in this factory. `main.ts` does not know
which concrete tools comprise the default set.

### BashTool

Bash retains command execution, cwd selection, stdout/stderr collection,
non-zero exit reporting, successful empty-output reporting, the existing small
dangerous-fragment guardrail, and timeout-driven shell-wrapper termination.

The duplicate runtime check for a non-string `command` is removed because the
Registry's TypeBox validation is the only supported execution path. Spawn error
and close handling remain because they are normal child-process outcomes.

## Timeout

Timeout support remains, but caller cancellation is removed.

Shared timeout helpers live in `src/utils/timeout.ts`, not at the source root and
not inside either the LLM or tools module. The utility converts seconds to safe
integer milliseconds and runs a Promise-producing operation against one internal
timeout signal:

```ts
runWithTimeout(seconds, (timeoutSignal) => operation(timeoutSignal));
```

The helper stops waiting when the deadline passes. Operations that support the
signal, including provider SDK calls and Bash `spawn()`, also receive the timeout
notification and can stop their underlying work.

The helper reports one internal timeout failure. Adapters translate it to
`LLMTimeoutError`; the Registry translates it to an error `ToolResult`. This
keeps timeout policy at the owning module rather than in the shared utility.

Streaming Adapters create one internal timeout signal for the lifetime of the
provider stream and pass it to the SDK. The basic design trusts official SDKs to
honor that signal; it does not race and defensively close every individual
`iterator.next()` call.

Removed cancellation behavior includes:

- a signal in public LLM call options;
- a signal parameter on `runAgentTurn()` and Registry callers;
- CLI active-run controllers;
- caller/timeout/lifecycle signal combination;
- first-abort-reason preservation;
- best-effort iterator closing that suppresses secondary failures.

## Errors

The LLM hierarchy becomes:

```text
LLMError
├── LLMConfigurationError
├── LLMTimeoutError
└── LLMProviderError
```

The dedicated authentication subclass is removed. Adapters still recognize
authentication failures and produce provider-specific authentication messages,
but use `LLMProviderError`.

The tools hierarchy becomes one expected execution error:

```ts
class ToolExecutionError extends Error {}
```

`ToolError` and `ToolConfigurationError` are removed. Registration and Registry
configuration mistakes throw ordinary `Error`s. `ToolExecutionError` remains so
expected tool failures can become concise model-visible results.

## Defensive Code Removed and Retained

Removed as premature:

- duplicate tool-argument object checks in Agent and Bash layers;
- schema deep clone/freeze behavior;
- exhaustive developer-misuse checks during registration;
- exhaustive caller message and tool-schema validation;
- runtime unknown-option rejection for typed option objects;
- unused Registry management methods other than `unregister()`;
- lazy proxy and injectable loader infrastructure;
- caller cancellation and multi-signal lifecycle handling;
- defensive stream iterator shutdown behavior;
- error types with no distinct consumer.

Retained because the data is untrusted or the behavior is core:

- provider response normalization and shape checks;
- provider tool arguments must normalize to an object;
- Registry TypeBox validation of model-produced arguments;
- duplicate and unknown tool handling;
- timeout behavior;
- tool error normalization;
- output truncation;
- child-process `error` and `close` handling.

## Testing

Tests continue to use fake SDK clients and never contact a live provider or read
`.env`.

Retained or added coverage includes:

1. each Adapter's message and tool schema translation;
2. `invoke()` text and tool-call normalization;
3. `stream()` text delta order and final `response_done` response;
4. streamed tool-call accumulation for Anthropic, OpenAI, and Gemini;
5. provider timeout and provider error normalization;
6. provider selection and asynchronous selected-Adapter creation;
7. Registry registration order, duplicate rejection, unregistration, and
   schema export;
8. model-produced argument validation without coercion;
9. unknown tools, tool timeout, execution errors, and truncation;
10. Bash success, empty output, non-zero exit, cwd, dangerous fragments, and
    timeout;
11. Agent event order for text-only and tool-using turns;
12. proof that no tool starts until its provider stream reaches
    `response_done`;
13. proof that tool results enter history before the next model stream; and
14. CLI rendering of the four Agent event variants.
15. importing the public entry point without loading `.env`, constructing an SDK
    client, or contacting a provider.

Tests dedicated only to removed defensive behavior are deleted, including:

- `as never` caller violations;
- unknown typed option keys;
- malformed custom Client and Tool implementations;
- handcrafted malformed TypeBox schemas;
- non-string returns from typed Tool implementations;
- schema clone and freeze guarantees;
- caller cancellation and abort-reason priority;
- iterator `return()` failure and permanent-pending behavior;
- lazy proxy loader selection and concurrent memoization.

## Documentation

README examples change to the asynchronous factory and the two-operation LLM
Interface. Streaming documentation explains that both operations support tools,
that tool calls execute only after `response_done`, and that the CLI consumes
Agent events. Cancellation is no longer documented; timeout remains.

## Acceptance Criteria

The refactor is complete when:

- `createLLMClient()` asynchronously returns the selected real Adapter;
- `LLMClient` exposes only `invoke()` and `stream()`;
- both operations work with and without tool schemas;
- all three Adapters stream text and produce complete final tool calls;
- `runAgentTurn()` emits ordered Agent events and mutates history only with
  complete messages;
- tool execution begins only after `response_done`;
- `createToolRegistry()` lives in the tools module;
- Registry retains `unregister()` and removes the agreed defensive surface;
- caller cancellation is absent while LLM and tool timeout behavior remains;
- no test reads `.env` or makes live provider calls;
- importing the public entry point has no environment, client-construction, or
  network side effects;
- type-checking, tests, build, and whitespace checks pass; and
- the worktree contains only the intentional refactor changes.
