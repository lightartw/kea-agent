# Coding Agent

`coding-agent` builds a ready-to-run coding assistant on top of Harness. Harness owns a
conversation run: it keeps the Session, drives the Agent loop, and publishes facts about
what happened. Coding Agent adds the defaults that make that run useful for project work:

- the coding system prompt;
- built-in tools for Bash, files, globbing, and todos;
- the default permission Hook for Bash commands;
- two UI seams: interaction requests and tool-event presentation.

It is a composition layer. It can use Agent Tool and Hook contracts while constructing the
runtime, but neither Harness nor Agent depends on Coding Agent or a concrete UI.

## Start with `createCodingAgent`

Create a Session first, then pass it with the project and model dependencies to the factory.
The optional `interactions` object is how a frontend handles confirmation requests. If it is
not supplied, the fail-closed `NO_INTERACTIONS` adapter rejects commands that require
confirmation.

```ts
import { createCodingAgent } from "./coding-agent/index.js";
import { Session } from "./harness/index.js";

const runtime = await createCodingAgent({
  project: { workDir: process.cwd(), storageDir: ".sessions" },
  streamFn,
  model,
  session: Session.inMemory(),
  interactions: myInteractions, // optional
});

await runtime.harness.prompt("List the files in this project.");
```

## `CodingAgentRuntime`

The factory returns the small runtime surface a frontend needs:

```ts
interface CodingAgentRuntime {
  readonly harness: AgentHarness;
  readonly presentations: CodingToolPresentationRegistry;
}
```

- Use `runtime.harness` to prompt, abort, inspect messages, and subscribe to `HarnessEvent`s.
- Pass a tool execution event from that subscription to `runtime.presentations.render(event)`
  when the frontend needs display text for it.

`CliFrontend` is one current adapter that uses this surface. A CLI, TUI, or web adapter can
use the same seams later.

## What the factory assembles

One `createCodingAgent()` call follows this assembly path:

1. Resolve `project.workDir` into the `CodingToolContext` (`{ cwd }`).
2. Create the built-in `CodingToolDefinition`s.
3. Convert every definition with `toAgentTool(definition, context)` and register the resulting
   `AgentTool` in an `AgentToolRegistry`.
4. Register each definition's optional presentation in a
   `CodingToolPresentationRegistry`.
5. Create `createDefaultCodingHookRegistry({ cwd, interactions })`. Its default control Hook
   is permission: it applies the shared Bash allow/ask/deny policy.
6. Construct `AgentHarness` with the Session, tools, Hook registry, system prompt, and model;
   return it together with the presentation registry.

This is why tool execution and presentation are related without making an `AgentTool` depend
on UI code: the tool definition is projected once into an executable Agent Tool and separately
into an optional presentation handler.

## Tool definitions and data lifetimes

A `CodingToolDefinition` names a tool, describes and validates its parameters, executes it,
and may carry a presentation handler:

```ts
interface CodingToolDefinition<TParameters, TDetails> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  execute(
    arguments_: Static<TParameters>,
    signal: AbortSignal,
    context: CodingToolContext,
  ): Promise<AgentToolResult<TDetails>>;
  readonly presentation?: CodingToolPresentation<Static<TParameters>, TDetails>;
}

interface CodingToolContext {
  readonly cwd: string;
}
```

A Tool has no single universal state scope. Identify each piece of data by its owner instead:

| Data | Owner | Lifetime |
| --- | --- | --- |
| Parameters, `AbortSignal`, and result of one execution | one **Tool Call** | ends with that call |
| Tool definitions, execution adapters, and `CodingToolContext` | one **Runtime** | from `createCodingAgent()` until that `CodingAgentRuntime` is discarded |
| Recoverable domain data in messages and `ToolResultMessage.details` | one **Session** | survives runs and restoration of that Session |
| Files and command side effects beneath `cwd` | the **project environment** | can outlive any Runtime or Session |

Put recoverable domain state in Session messages, not in a hidden Tool instance. File contents,
on the other hand, belong to the project environment: restoring a Session does not roll back a
file written by `write_file` or a command run by `bash`.

## Todo state is projected from the Session

`todo_write` is stateless. Every call receives the complete todo list and returns both
model-visible `content` and program-visible `details.todos` from that input. It does not retain
the previous list in a Tool object.

Harness persists the result as a Session message. `tools/builtin/todo/projection.ts` provides
`findLatestTodoDetails(messages)`, which reconstructs the current todo domain state by finding
the latest valid `todo_write` result in the current Session message history. This keeps todo
state recoverable across runs without introducing a general Tool state container.

```ts
interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

interface TodoDetails {
  readonly todos: readonly TodoItem[];
}
```

## Four distinct extension points

These terms describe different directions of communication. Keeping them separate prevents UI
code from accidentally becoming part of tool execution control.

| Concept | Direction and timing | Purpose |
| --- | --- | --- |
| **Agent Hook** | control channel, before an Agent action commits | can block or change work; the built-in permission Hook gates Bash commands |
| **interactions** | a Hook asks the frontend | `CodingAgentInteractions.confirm()` obtains permission; `notify()` reports an immediate Hook-originated notice |
| **Harness Event** | passive fact stream after/while work happens | `runtime.harness.subscribe()` observes run, text, and tool facts; listener results cannot change the Agent |
| **presentation** | a frontend turns a tool Harness Event into text | `CodingToolPresentationRegistry` selects a tool presentation and provides a safe fallback |

`interactions` lives at `ui/interactions/`; `presentation` lives at `ui/presentation/`.
Neither is a UI implementation. A future CLI, TUI, or web adapter may implement the
interaction port and consume presentation output, but this package does not claim those
frontends already exist beyond the current CLI adapter.

The default permission Hook handles Bash policy as follows: hard-denied commands are blocked;
ask-classified commands call `interactions.confirm()`; when interactions are unavailable,
ask-classified commands are denied. Tool starts, ends, rejections, output-size notices, and
tool counts are passive display concerns, so they come from Harness Events rather than Hooks.

## Source layout and dependency direction

```text
src/coding-agent/
  factory.ts                 # createCodingAgent composition root
  runtime.ts                 # CodingAgentRuntime
  types.ts                   # factory configuration
  coding-system-prompt.ts
  tools/
    definition.ts            # shared tool contract
    wrapper.ts               # CodingToolDefinition -> AgentTool
    builtin/                 # Kea's default tool set
      bash/
      files.ts
      glob.ts
      todo/
        definition.ts
        projection.ts
  hooks/
    types.ts                 # shared Hook context and registry type
    builtin/                 # default permission Hook and factory
  ui/
    interactions/            # frontend confirmation/notification port
    presentation/            # tool event-to-text contract and registry
```

`tools/` and `hooks/` contain shared Coding Agent mechanisms. Their `builtin/` subdirectories
contain the default Kea capabilities. UI source depends on this package, while this package does
not import `src/ui`:

```text
ui -> coding-agent -> harness -> agent -> ai
```

## Complete public API

Import public Coding Agent APIs from `src/coding-agent/index.ts` (or the package root), not
from the internal paths above.

### Values

- `createCodingAgent`
- `createDefaultCodingHookRegistry`
- `createDefaultToolDefinitions`
- `toAgentTool`
- `CODING_SYSTEM_PROMPT`
- `NO_INTERACTIONS`
- `CodingToolPresentationRegistry`

### Types

- `CodingAgentRuntime`, `CreateCodingAgentConfig`
- `CodingHookContext`
- `CodingAgentInteractions`, `ConfirmationRequest`, `Notification`
- `CodingToolContext`, `CodingToolDefinition`
- `CodingToolPresentation`, `ToolPresentationCall`, `ToolPresentationRejected`
- `TodoItem`, `TodoDetails`

The lower-level modules are internal or built-in implementation details, including the
individual built-in tool factories, `registerPermissionHook`, the Bash policy helpers, and the
concrete adapter classes. They are useful inside this repository but are not the stable public
surface of `coding-agent`.
