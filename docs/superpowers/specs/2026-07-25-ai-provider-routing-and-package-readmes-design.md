# AI Provider Routing and Package README Design

**Date:** 2026-07-25

## Summary

Kea keeps the existing `StreamFn(model, context, options)` contract while
changing `createStreamFn()` from a single-provider factory into a small
provider router. All configured providers are registered once, adapters remain
lazy, and each request selects its provider through `ModelConfig.provider`.

The `ai` and `agent` READMEs will be rewritten around package responsibilities
and the boundary between them. Similar concepts in adjacent packages use
package-owned names and explicit translation instead of allowing transport
types to flow through every higher layer.

The change also fixes loss of `AgentToolResult.isError` when a tool result is
stored as a message.

## Goals

- One `StreamFn` can switch between every provider configured at startup.
- Switching provider or model requires only replacing `ModelConfig`.
- `DEFAULT_PROVIDER` selects the default provider without restricting routing.
- Built-in and custom adapters remain lazy and are reused after creation.
- Tool execution errors retain `isError` in agent message history and
  `AgentState.errorMessage`.
- `src/ai/README.md` explains one LLM turn and the ai package boundary.
- `src/agent/README.md` explains one agent run, its repeated turns, and the
  purpose of agent-owned parallel concepts.

## Non-goals

- Reading or writing the application's future JSON configuration format.
- Designing the harness configuration or persistence system.
- Hot-adding a provider after `createStreamFn()` has returned.
- Copying Pi's full `Models`, credential store, model catalog, refresh, or
  authentication system.
- Changing the `StreamFn`, `ModelConfig`, `Context`, or streaming event shapes.
- Making `AgentMessage` structurally different from `ai.Message` in this pass.
- Changing tool execution order or making tools concurrent.

## Design Principles

### Default selection is separate from request routing

The application owns persistent user configuration. Before it calls the ai
factory, it may load JSON configuration and expose the resulting environment or
pass an explicit environment object.

The ai package owns provider routing:

- every provider with an available API key is registered;
- `DEFAULT_PROVIDER` selects the provider used in `defaultModel`;
- `MODEL_ID` selects the model used in `defaultModel`;
- every stream request dispatches by its own `ModelConfig.provider`.

Changing `Agent.model` is therefore sufficient for both same-provider model
switches and cross-provider switches.

### Package concepts cross one boundary through translation

Each package describes concepts in its own vocabulary:

- `ai.Message`, `ai.Tool`, and `ai.ToolCall` are LLM protocol data;
- `AgentMessage`, `AgentTool`, and `AgentToolCall` are agent-domain concepts;
- `AgentMessage` is currently an intentional alias of `ai.Message`;
- `AgentToolCall` is currently a parallel structure translated explicitly from
  `ai.ToolCall`;
- `AgentTool` adds validation and execution behavior while satisfying the
  adjacent ai `Tool` schema contract.

The current alias and structurally similar interfaces are deliberate seams.
They allow either package to diverge later without forcing ai transport types
through unrelated upper layers. README wording must describe the current
degree of coupling honestly and must not claim that the packages are already
fully independent.

## Provider Factory

`createStreamFn()` retains its current public return value:

```ts
{
  stream: StreamFn;
  defaultModel: ModelConfig;
}
```

Provider discovery changes as follows:

1. Combine built-in and caller-supplied `ProviderConfig` entries.
2. Select every entry whose `envApiKey` resolves to a non-empty value.
3. Reject when no provider is configured.
4. Read `DEFAULT_PROVIDER`.
5. If `DEFAULT_PROVIDER` is present, reject unless it names a configured
   provider.
6. If `DEFAULT_PROVIDER` is absent:
   - infer it when exactly one provider is configured;
   - reject when multiple providers are configured.
7. Require `MODEL_ID` and construct `defaultModel` from the selected provider
   and model ID.
8. Create one lazy adapter per configured provider.
9. For every call, route with `model.provider` and pass `model.model` to the
   selected adapter.

This preserves the current convenient single-provider setup while making a
multi-provider configuration explicit and deterministic.

### Errors

The factory throws configuration errors for:

- no configured provider;
- multiple configured providers without `DEFAULT_PROVIDER`;
- `DEFAULT_PROVIDER` naming an unconfigured provider;
- missing `MODEL_ID`.

The returned stream throws `Unknown provider` when a request asks for a
provider that was not configured at factory creation time.

## Agent Tool Error Propagation

`runAgentLoop()` already receives `AgentToolResult` with:

```ts
{
  content: string;
  isError: boolean;
}
```

When it appends the corresponding tool message, it will also copy
`isError: result.isError`. This makes three views consistent:

- the `tool_end` event;
- the stored `ToolResultMessage`;
- the `Agent.state.errorMessage` scan performed at `agent_end`.

No other error semantics change.

## README Structure

### `src/ai/README.md`

The document will answer, in order:

1. What the package does: normalize one streaming LLM turn.
2. The central contract: model + complete context + options → event stream.
3. What the package owns and does not own.
4. How configured providers, `DEFAULT_PROVIDER`, and per-request routing work.
5. How protocol-level messages, tool schemas, and tool calls are represented.
6. A minimal runnable usage example.
7. A short extension example for a custom provider.

It will not reproduce every interface or document adapter internals.

### `src/agent/README.md`

The document will answer, in order:

1. What the package does: turn one user prompt into a multi-turn tool loop.
2. The distinction between run, turn, and the stateful `Agent` wrapper.
3. The normal loop data flow and stop condition.
4. The package boundary with ai and the reason for parallel concepts.
5. The responsibilities of `AgentTool` and `AgentToolRegistry`.
6. Agent event categories and lifecycle callbacks.
7. Cancellation behavior, including the current inability to interrupt an
   already running tool with the caller's abort signal.
8. A minimal runnable agent/tool example.

It will not document harness design or list source-file imports.

## Testing

Provider routing tests will prove:

- one configured provider is inferred without `DEFAULT_PROVIDER`;
- multiple configured providers require `DEFAULT_PROVIDER`;
- a valid `DEFAULT_PROVIDER` selects `defaultModel`;
- an unknown or unconfigured default is rejected;
- one returned stream dispatches calls to two different configured adapters.

Agent tests will prove:

- a failing tool result is stored with `isError: true`;
- `Agent.state.errorMessage` observes the stored tool error after the run ends.

After implementation, run:

```text
npm run typecheck
npm test
git diff --check
```

The README examples will be checked against public exports and current
constructor/function signatures.
