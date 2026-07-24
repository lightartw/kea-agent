# agent

Agent kernel. Stateful wrapper + pure loop + generic tool/hook infrastructure.

Knows nothing about concrete tools (bash, files) or presentation (CLI, TUI).

## Exports

### `Agent` — [agent.ts](agent.ts)

Stateful wrapper owning conversation history and system prompt.

```ts
import { Agent } from "./agent/agent.js";

const agent = new Agent(client, registry, [], "You are helpful.", hooks);

agent.state        // AgentState — { messages, systemPrompt, isRunning, errorMessage? }
agent.messages     // readonly Message[]
agent.isRunning    // boolean

agent.prompt("hi") // AsyncIterable<AgentEvent> — one user turn through the loop
agent.abort()      // cancel current run (ESC key → HTTP cancel + loop exit)
agent.reset()      // clear history + error state
```

### `runAgentLoop` — [agent-loop.ts](agent-loop.ts)

Pure function. Mutates `messages` in-place, yields typed events. Usable directly in tests.

```ts
import { runAgentLoop } from "./agent/agent-loop.js";

async function* runAgentLoop(
  messages: Message[],        // mutated in-place
  systemPrompt: string,
  client: LLMClient,
  registry: ToolRegistry,
  hooks?: HookRegistry,
  signal?: AbortSignal,       // agent.abort() propagates through here
): AsyncIterable<AgentEvent>
```

### `AgentEvent` — [types.ts](types.ts)

11 discriminated event types. No optional fields.

```ts
type AgentEvent =
  // Run lifecycle
  | { type: "agent_start" }
  | { type: "agent_end";   messages: readonly Message[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end";    message: AssistantMessage }
  // Streaming
  | { type: "text_delta";      text: string }
  | { type: "thinking_delta";  thinking: string }
  | { type: "toolcall_start";  id: string; name: string }
  | { type: "toolcall_delta";  id: string; argumentsDelta: string }
  | { type: "toolcall_end";    toolCall: ToolCall }
  // Tool execution
  | { type: "tool_start";      call: ToolCall }
  | { type: "tool_end";        call: ToolCall; result: ToolResult }
```

### `AgentState` — [types.ts](types.ts)

```ts
interface AgentState {
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
```

### `AgentTool<T>` — [tools/types.ts](tools/types.ts)

Abstract base class for all tools. Implements `Tool` from llm-client, adds `validate()` and `execute()`.

```ts
abstract class AgentTool<T extends TObject = TObject> implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: T;
  validate(args: unknown): string | undefined;                    // TypeBox check
  abstract execute(args: Static<T>, signal: AbortSignal): Promise<string>;
}
```

### `ToolRegistry` — [tools/registry.ts](tools/registry.ts)

Stores `AgentTool` instances. Validates arguments. Runs pre/post-tool hooks.

```ts
class ToolRegistry {
  constructor(timeout?: number, hooks?: HookRegistry);
  register(tool: AgentTool): void;
  unregister(name: string): void;
  schemas(): Tool[];          // AgentTool implements Tool
  execute(call: ToolCall): Promise<ToolResult>;
}
```

### Hook system — [hooks/](hooks/)

5 lifecycle events, chain semantics (first non-void return stops the chain).

```ts
type HookEventUnion =
  | UserPromptSubmitEvent   // Agent.prompt() — { type, prompt }
  | PreToolUseEvent         // ToolRegistry.execute() — { type, call }
  | PostToolUseEvent        // ToolRegistry.execute() — { type, call, result }
  | PreTurnEvent            // runAgentLoop() — { type }
  | StopEvent               // runAgentLoop() — { type, messages }

interface HookResult {
  block?: boolean;          // deny (user_prompt_submit, pre_tool_use)
  reason?: string;
  messages?: readonly Message[];  // replace history (stop)
  context?: string;         // inject context (user_prompt_submit, pre_turn)
  forceContinue?: string;   // keep looping (stop)
}

interface Hook<TEvent> {
  name: string;
  eventType: TEvent["type"];
  execute(event: TEvent): HookResult | void | Promise<HookResult | void>;
}

class HookRegistry {
  register(hook: Hook): void;
  get<T>(name: string): T | undefined;
  trigger<TEvent>(event: TEvent): Promise<HookResult | undefined>;
}
```

## Usage

Minimal:

```ts
const client = await createLLMClient();
const agent = new Agent(client, new ToolRegistry(), [], "You are helpful.");

for await (const event of agent.prompt("What is 2+2?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

With tool + hook:

```ts
class EchoTool extends AgentTool<typeof Type.Object({ msg: Type.String() })> {
  constructor() { super("echo", "Echo.", Type.Object({ msg: Type.String() })); }
  async execute(args) { return args.msg; }
}

const hooks = new HookRegistry();
hooks.register(new PermissionHook());

const registry = new ToolRegistry(120, hooks);
registry.register(new EchoTool());

const agent = new Agent(client, registry, [], "You are helpful.", hooks);
for await (const event of agent.prompt("echo 'hi'")) { /* render */ }
```

Testing with `runAgentLoop` directly (no Agent needed):

```ts
const history: Message[] = [{ role: "user", content: "hi" }];
const client = { async *stream() { yield { type: "done", message }; } };

for await (const event of runAgentLoop(history, "", client, new ToolRegistry())) {
  // assert on events
}
```

## Dependencies

Imports from llm-client:

- **Data types** (global, any package can import): `Message`, `AssistantMessage`, `ToolCall`, `Tool`
- **Transport types** (agent-loop boundary): `LLMClient`, `Context`

Never re-exports llm-client types. Consumers import `Tool` or `ToolCall` from llm-client directly.
