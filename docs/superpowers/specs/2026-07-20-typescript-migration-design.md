# TypeScript Migration Design

**Date:** 2026-07-20

## Summary

Kea Agent will be translated from Python to TypeScript without adding product
features or changing its intended behavior. The migration will retain the
current architecture: a provider-neutral asynchronous LLM client, independent
Anthropic/OpenAI/Gemini adapters, a registry-centered tool system, an
asynchronous Bash tool, and a sequential Agent loop.

The work will proceed in dependency order. Python remains available as a local
implementation reference during the translation. After the TypeScript version
passes its complete acceptance suite, all Python code and tooling will be
removed and `master` will be rebuilt as a single TypeScript root commit.

## Goals

- Translate the existing implementation to idiomatic, strict TypeScript.
- Preserve the current supported providers, public semantics, configuration
  precedence, tool behavior, and sequential Agent loop.
- Add a new TypeScript regression suite that demonstrates behavioral parity
  without restoring the deleted Python tests.
- Use the official TypeScript SDK from each provider directly.
- Finish with a pure TypeScript repository and one new root commit on `master`.

## Non-goals

- Building a TUI or introducing React/Ink.
- Adding Agent features, tools, MCP, permissions, retries, persistence, or
  parallel tool execution.
- Adopting an Agent framework or a provider-unification framework.
- Restoring the deleted Python test suite.
- Deliberately fixing the four known defects recorded before this migration:
  non-object provider tool arguments, Bash process-tree cancellation, truncated
  error prefixes at extremely small result limits, and non-finite tool timeout
  validation.
- Adding regression assertions that make those known defects permanent
  requirements.

## Engineering Baseline

The project will use:

- Node.js 24 LTS;
- npm and a committed `package-lock.json`;
- ECMAScript modules;
- TypeScript with `strict` enabled;
- the Node.js built-in test runner and assertion library;
- `tsc` for type-checking and compilation.

Runtime dependencies are limited to the official Anthropic, OpenAI, and Google
Gen AI SDKs, `dotenv`, and TypeBox. Development dependencies are limited to
TypeScript and the Node.js type declarations unless implementation reveals a
strictly necessary additional build dependency.

`package.json` becomes the dependency source of truth. There is no generated
equivalent of `requirements.txt`; `package-lock.json` is the reproducibility
artifact.

## Target Structure

```text
src/
├── index.ts
├── main.ts
├── agent-loop.ts
├── utils/
│   └── abort-signals.ts
├── llm-client/
│   ├── index.ts
│   ├── client.ts
│   ├── models.ts
│   ├── errors.ts
│   ├── factory.ts
│   └── adapters/
│       ├── anthropic.ts
│       ├── openai.ts
│       └── gemini.ts
└── tools/
    ├── index.ts
    ├── base.ts
    ├── errors.ts
    ├── registry.ts
    └── builtin/
        └── bash.ts

tests/
├── llm-client/
├── tools/
└── agent-loop.test.ts
```

The dependency direction remains:

```text
main -> agent-loop

agent-loop
  ├── LLMClient public contract
  └── ToolRegistry public contract

LLM adapters -> LLM public models and validation
ToolRegistry  -> Tool public contract and TypeBox
BashTool      -> Tool public contract and Node child_process
```

`llm-client` and `tools` must not import one another. Plain TypeScript values
and the provider-neutral OpenAI function-tool schema remain their boundary.
`index.ts` is a side-effect-free public entry point. `main.ts` is the only
module that loads `.env`, reads terminal input, installs process handlers, or
starts the program. Importing the library modules must not inspect credentials,
construct an SDK client, or access the network.

## Public LLM Contract

Local TypeScript APIs use `camelCase`. Provider payloads retain the naming
required by their SDKs and HTTP APIs.

```ts
interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface LLMResponse {
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly latencyMs: number;
  readonly finishReason: "stop" | "length" | "tool_calls" | null;
}

interface LLMClient {
  invoke(
    messages: readonly Message[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  invokeWithTools(
    messages: readonly Message[],
    tools: readonly ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  streamInvoke(
    messages: readonly Message[],
    options?: LLMCallOptions,
  ): AsyncIterable<string>;
}

interface LLMOptions {
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: readonly string[];
}

interface LLMCallOptions extends LLMOptions {
  signal?: AbortSignal;
}
```

Messages become a discriminated union of system, user, assistant, and tool
result messages. Assistant content remains nullable when it contains tool calls.
No tool invocation remains represented by an empty `toolCalls` array. Tool
arguments use `Record<string, unknown>`.

`signal` is invocation control, not a persistent model option. It may be
supplied only per call and must never be stored among client defaults.

The OpenAI function-tool shape remains the provider-neutral public tool schema.
The LLM layer retains lightweight runtime validation because callers may use it
without a `ToolRegistry`.

## Options and Client Factory

The common option allowlist remains:

```text
timeout
maxTokens
temperature
topP
stop
```

Internal defaults remain `maxTokens=8000` and `timeout=120` seconds. Optional
sampling values and stop sequences are omitted unless configured. Per-call
options override client defaults, and client defaults override internal
defaults. Unknown options raise `LLMConfigurationError`.

`createLLMClient()` accepts explicit provider, model, API key, base URL, and
common defaults. When provider is omitted, it checks only:

```text
ANTHROPIC_API_KEY -> anthropic
OPENAI_API_KEY    -> openai
GEMINI_API_KEY    -> gemini
```

Exactly one marker must be set. Detection must not inspect model names, URLs,
key contents, installed SDKs, or network state. Configuration precedence
remains explicit argument, provider environment variable, then library default.
`MODEL_ID` and the existing provider-specific base URL variables remain
supported.

The factory remains synchronous. It validates and resolves configuration, then
returns a small memoizing client proxy. On the first invocation, that proxy
dynamically imports only the selected adapter; the adapter in turn loads only
its own official SDK. Concurrent first calls share one loader promise. A loader
failure becomes `LLMProviderError` with its original cause and does not cause any
other provider SDK to load.

## Provider Adapters

Each adapter independently implements `LLMClient`; there is no shared provider
base class.

### Anthropic

- Extract and join system messages.
- Batch consecutive tool results into Anthropic user content blocks.
- Convert assistant calls to `tool_use` blocks.
- Map common tool `parameters` to `input_schema`.
- Map `stop` to `stop_sequences`.

### OpenAI

- Use Chat Completions messages.
- Convert assistant tool arguments to JSON strings in conversation history.
- Pass the common OpenAI function-tool schema directly.
- Preserve the existing max-token and sampling option mapping.

### Gemini

- Convert assistant messages to Gemini `model` contents.
- Convert tool calls and results to function call/response parts.
- Convert common tools to Gemini function declarations.
- Map the system instruction, output-token limit, sampling values, and stop
  sequences to Gemini configuration.

All adapters normalize text, tool calls, usage, latency, and finish reasons to
the common response. Tool calling remains non-streaming. `streamInvoke()` yields
non-empty text fragments only and does not return a final response object.

Adapter constructors permit injection of a fake SDK client for tests. The
factory creates official SDK clients in production.

## Cancellation, Timeout, and Errors

JavaScript cancellation is explicit, so `AbortSignal` replaces Python task
cancellation as the internal cancellation mechanism. It is plumbing needed to
preserve behavior, not a new product feature.

`utils/abort-signals.ts` combines the optional caller signal with the internal
timeout signal while preserving the first abort reason. It returns an explicit
cleanup function, and every completion, failure, cancellation, or early stream
exit removes installed listeners. Public `timeout` remains measured in seconds
for behavioral parity and is converted to milliseconds only when constructing
the timeout signal.

- LLM timeouts abort the underlying request and become `LLMTimeoutError`.
- Caller-initiated aborts propagate without being wrapped as provider errors.
- Early termination of a text stream aborts and closes the provider stream.
- Registry timeout aborts the executing tool.
- BashTool terminates its current shell wrapper when aborted.

The public hierarchy remains:

```text
LLMError
├── LLMConfigurationError
├── LLMTimeoutError
├── LLMAuthenticationError
└── LLMProviderError
```

Authentication errors are translated separately. Other SDK, network, and
provider errors become `LLMProviderError`. Wrapped errors retain the original
error through the standard `cause` property.

The migration does not add process-group or Windows tree-kill behavior to
BashTool; that remains a separate known fix.

## Tool System

`Tool` remains an explicit asynchronous contract. TypeBox supplies both the
serializable JSON Schema and the static argument type:

```ts
abstract class Tool<TParameters extends TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly timeout: number | null;

  toSchema(): ToolSchema;

  abstract execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
  ): Promise<string>;
}
```

There is no schema reflection, decorator registration, string argument parsing,
implicit coercion, global Registry, or separate executor.

Tools define schemas explicitly with TypeBox constructors. The schema object is
passed unchanged into the common OpenAI function-tool wrapper. Registry
validation uses TypeBox compilation/checking only; it must not call conversion,
cleaning, defaulting, or mutation helpers. Provider-produced arguments remain
unknown data until this runtime validation succeeds.

Registry execution accepts an optional caller signal:

```ts
registry.execute(name, arguments_, signal?): Promise<ToolResult>;
```

It combines that signal with its own timeout signal and passes the combined
signal to the tool.

`ToolRegistry` remains responsible for:

1. validating tool metadata and JSON Schema at registration;
2. rejecting duplicate names;
3. exporting schemas in registration order;
4. compiling and validating structured arguments with TypeBox without
   coercion or mutation;
5. choosing the tool-specific or default timeout;
6. propagating cancellation through an `AbortController`;
7. normalizing expected invocation failures into `ToolResult`;
8. truncating content to the configured result limit.

The Registry continues to execute one call at a time. The Agent loop invokes it
sequentially in provider response order.

## BashTool

BashTool uses Node's child-process API with `shell: true`, the configured
working directory, and captured stdout/stderr. It preserves the existing
dangerous-command fragments and behavior:

- command must be a string;
- dangerous fragments are rejected;
- stdout and stderr are concatenated and trimmed;
- successful empty output becomes `"(no output)"`;
- non-zero exit produces `ToolExecutionError` with captured detail;
- cancellation kills the shell wrapper and propagates.

The migration does not extend cancellation to the complete process tree.

## Agent Loop and CLI

The CLI remains a simple line-oriented interface, not a TUI. `main.ts` loads
`.env` with override behavior, creates the unified client, explicitly creates a
Registry, registers BashTool, and calls the independently exported Agent loop.
`agent-loop.ts` contains no terminal initialization or environment loading and
accepts its client, Registry, history, and optional abort signal explicitly.

For each user turn, the loop:

1. sends history plus `registry.schemas()` to `invokeWithTools()`;
2. appends the normalized assistant response;
3. returns immediately when there are no tool calls;
4. otherwise executes each call sequentially;
5. prints the tool invocation and a short result preview;
6. appends common tool-result messages;
7. invokes the model again.

The prompt text, exit commands, output colors, current-working-directory
behavior, and user-visible flow remain unchanged.

## Testing Strategy

Tests use `node:test` and `node:assert`. TypeScript is compiled before generated
test JavaScript is executed. Tests do not make live API requests and do not read
the user's `.env` file or credentials.

Coverage includes:

1. provider detection with zero, one, and multiple markers;
2. explicit provider selection and configuration precedence;
3. common option defaults, overrides, and invalid option handling;
4. common message and function-tool validation;
5. request translation for all three adapters;
6. response and tool-call normalization for all three adapters;
7. text-only asynchronous streaming for all three adapters;
8. timeout, authentication, provider error, and abort behavior;
9. lazy adapter loading, loader memoization, and side-effect-free core imports;
10. Registry registration, ordering, TypeBox schema validation, execution, timeout,
   truncation, error normalization, and cancellation;
11. BashTool success, empty output, non-zero exit, dangerous command, working
    directory, and cancellation behavior;
12. an Agent loop round trip with fake clients and sequential tool execution;
13. importing project modules without reading environment configuration,
    constructing SDK clients, or contacting a provider.

Known defects excluded from the migration scope are not encoded as desired
behavior. Their eventual fixes require separately authorized regression tests.

## Migration Sequence

Implementation proceeds in this order:

1. Add Node/npm/TypeScript configuration and test commands.
2. Add the side-effect-free public entry point, abort-signal utility, and tests.
3. Add tests and translations for public models, messages, errors, options, and
   validation.
4. Add tests and translations for Anthropic, OpenAI, and Gemini adapters.
5. Add tests and the memoizing lazy client factory.
6. Add tests and TypeBox-based translations for Tool, ToolResult, tool errors,
   and Registry.
7. Add tests and the translated BashTool.
8. Add tests and translations for the standalone Agent loop and CLI entry.
9. Update README, `.env.example`, and `.gitignore` for Node/npm usage.
10. Run the complete acceptance suite.
11. Remove all Python sources and project tooling, the local `.venv`, Python
    caches, and superseded Python implementation plans/specifications.
12. Re-run acceptance from a clean `npm ci` installation.
13. Rebuild `master` as a single root commit, expire reflogs, and prune old Git
    objects.

Python remains available as a reference until step 11. Git history remains
available until every code and documentation check passes. History destruction
must never occur as an intermediate migration step.

## Documentation and Repository Cleanup

README setup instructions change to Node.js 24 LTS and npm. Linux/macOS remains
the primary setup path, with Windows PowerShell documented separately. Provider
environment variables, selection rules, and usage examples are rewritten in
TypeScript.

The final repository removes:

- all `.py` files;
- `pyproject.toml`;
- `uv.lock`;
- `requirements.txt`;
- `.venv`, `.pytest_cache`, and Python bytecode caches;
- dated Python implementation plans/specifications superseded by this design.

The ignored `.env` file remains in place and is never read, displayed, or
committed. Node build output and `node_modules` are ignored.

## Git History Replacement

The repository currently has no configured remote. After final acceptance, the
verified TypeScript worktree becomes an orphan `master` root commit. Old branch
references and reflogs are removed, and unreachable objects are pruned. The
expected final history contains exactly one commit.

No force-push or remote mutation is part of this migration. If a remote is added
before the history-replacement step, remote handling requires a separate scope
check before proceeding.

## Acceptance Criteria

The migration is complete only when:

```text
npm ci
npm run typecheck
npm test
npm run build
git diff --check
git status --short
git rev-list --count master
```

meet these conditions:

- dependency installation succeeds from `package-lock.json`;
- strict type-checking succeeds;
- all TypeScript regression tests pass;
- the production build succeeds;
- importing the public core has no environment, SDK-construction, or network
  side effects;
- no whitespace errors or uncommitted changes remain;
- no Python implementation or Python project artifacts remain;
- no test contacts a live provider or reads `.env` credentials;
- `master` contains exactly one root commit after history replacement.
