import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { runAgentLoop } from "../../src/core/harness/agent-loop.js";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
} from "../../src/core/harness/types.js";
import { HarnessEventBus } from "../../src/core/harness/events.js";
import { HarnessHooks } from "../../src/core/harness/hooks.js";
import { AgentTool, type AgentToolResult } from "../../src/core/harness/tools/types.js";
import type { AgentToolCall } from "../../src/core/harness/tools/types.js";
import { AgentToolRegistry } from "../../src/core/harness/tools/registry.js";
import type {
  AssistantMessage,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  StreamChunk,
} from "../../src/core/ai/types.js";
import type { TestStream } from "../fixtures/model-runtime.js";

const emptyParameters = Type.Object({}, { additionalProperties: false });
const typedParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);
const testModel: ModelConfig = { provider: "test", model: "test-model" };

function makeConfig(): AgentLoopConfig {
  return {
    model: testModel,
    convertToLlm: (msgs) => msgs,
  };
}

function memoryContext(
  tools = new AgentToolRegistry(),
  history: AgentMessage[] = [],
  hooks = new HarnessHooks(),
  events = new HarnessEventBus(),
  signal?: AbortSignal,
): AgentContext {
  return {
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    systemPrompt: "",
    messages: history,
    tools,
    hooks,
    events,
    ...(signal === undefined ? {} : { signal }),
    appendMessage: async (message) => { history.push(message); },
  };
}

function assistantMsg(
  text: string,
  extraContent: ContentBlock[] = [],
): AssistantMessage {
  const content: ContentBlock[] = [];
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  content.push(...extraContent);
  const hasToolCalls = extraContent.some((block) => block.type === "toolCall");
  return {
    role: "assistant",
    content,
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    stopReason: hasToolCalls ? "toolUse" : "stop",
    latencyMs: 0,
  };
}

function streamWithEvents(
  streams: readonly (readonly StreamChunk[])[],
  beforeStream?: (context: Context, index: number) => void,
): TestStream {
  let index = 0;
  return async function* (_model, context) {
    const current = index;
    index += 1;
    beforeStream?.(context, current);
    for (const event of streams[current] ?? []) yield event;
  };
}

function streamForToolCall(call: AgentToolCall): TestStream {
  return streamWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ]);
}

class TypedTool extends AgentTool<typeof typedParameters> {
  ran = false;
  constructor() {
    super("typed", "Typed tool.", typedParameters);
  }
  async execute(
    arguments_: Static<typeof typedParameters>,
  ): Promise<AgentToolResult> {
    this.ran = true;
    return { content: arguments_.value, isError: false };
  }
}

class NoopTool extends AgentTool<typeof emptyParameters> {
  ran = false;
  constructor() {
    super("noop", "No-op tool.", emptyParameters);
  }
  async execute(): Promise<AgentToolResult> {
    this.ran = true;
    return { content: "raw", isError: false };
  }
}

// ── beforePrompt ──

test("beforePrompt returning undefined prevents message insertion and model calls", async () => {
  const hooks = new HarnessHooks();
  hooks.on("beforePrompt", () => undefined);
  let streams = 0;
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history, hooks);

  await runAgentLoop(
    "secret",
    context,
    makeConfig(),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg("unused") };
    },
  );

  assert.equal(streams, 0);
  assert.deepEqual(history, []);
});

test("beforePrompt passing the prompt through runs the Run", async () => {
  const hooks = new HarnessHooks();
  hooks.on("beforePrompt", ({ prompt }) => ({ prompt }));
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history, hooks);

  await runAgentLoop(
    "hello",
    context,
    makeConfig(),
    async function* () {
      yield { type: "done", message: assistantMsg("done") };
    },
  );

  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
});

test("beforePrompt transformation reaches persisted history and the model request", async () => {
  const hooks = new HarnessHooks();
  hooks.on("beforePrompt", ({ prompt }) => ({ prompt: prompt.toUpperCase() }));
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history, hooks);
  let requestMessages: readonly Message[] = [];

  await runAgentLoop(
    "hello",
    context,
    makeConfig(),
    async function* (_model, context) {
      requestMessages = [...context.messages];
      yield { type: "done", message: assistantMsg("done") };
    },
  );

  const userContent = (message: Message): string | null =>
    message.role === "user" ? String(message.content) : null;
  assert.equal(userContent(history[0]!), "HELLO");
  assert.equal(userContent(requestMessages[0]!), "HELLO");
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
});

// ── transformContext ──

test("transformContext reaches the model without replacing history", async () => {
  const hooks = new HarnessHooks();
  hooks.on("transformContext", ({ messages }) => ({
    messages: [
      ...messages,
      { role: "user", content: "request-only" },
    ],
  }));
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history, hooks);
  let requestMessages: readonly Message[] = [];

  await runAgentLoop(
    "real",
    context,
    makeConfig(),
    async function* (_model, context) {
      requestMessages = [...context.messages];
      yield { type: "done", message: assistantMsg("done") };
    },
  );

  assert.deepEqual(
    requestMessages.map((message) =>
      message.role === "user" ? message.content : message.role
    ),
    ["real", "request-only"],
  );
  assert.deepEqual(
    history.map((message) =>
      message.role === "user" ? message.content : message.role
    ),
    ["real", "assistant"],
  );
});

// ── beforeTool and facts ──

test("invalid arguments fail before beforeTool runs", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "typed",
    arguments: { value: 1 },
  };
  const hooks = new HarnessHooks();
  let beforeToolCalls = 0;
  hooks.on("beforeTool", () => {
    beforeToolCalls += 1;
  });
  const events = new HarnessEventBus();
  const results: AgentToolResult[] = [];
  events.on("tool-result", (event) => { results.push(event.result); });

  await runAgentLoop(
    "run",
    memoryContext(tools, [], hooks, events),
    makeConfig(),
    streamForToolCall(call),
  );

  assert.equal(tool.ran, false);
  assert.equal(beforeToolCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, true);
  assert.match(results[0]!.content, /Invalid arguments for tool 'typed'/);
});

test("beforeTool deny blocks execution", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const hooks = new HarnessHooks();
  hooks.on("beforeTool", () => ({
    kind: "deny",
    reason: "denied by policy",
  }));
  const context = memoryContext(tools, history, hooks);
  const events = new HarnessEventBus();
  const results: AgentToolResult[] = [];
  events.on("tool-result", (event) => { results.push(event.result); });

  await runAgentLoop(
    "run",
    { ...context, events },
    makeConfig(),
    streamForToolCall(call),
  );

  assert.equal(tool.ran, false);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { content: "Error: denied by policy", isError: true });
});

// ── shared signal ──

test("the same AbortSignal reaches every control hook", async () => {
  const hooks = new HarnessHooks();
  const seen: Array<{ type: string; signal: AbortSignal | undefined }> = [];
  hooks.on("beforePrompt", (input, ctx) => {
    seen.push({ type: "beforePrompt", signal: ctx.signal });
    return { prompt: input.prompt };
  });
  hooks.on("transformContext", (input, ctx) => {
    seen.push({ type: "transformContext", signal: ctx.signal });
    return { messages: input.messages };
  });
  hooks.on("beforeTool", (_input, ctx) => {
    seen.push({ type: "beforeTool", signal: ctx.signal });
  });
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const controller = new AbortController();

  await runAgentLoop(
    "run",
    memoryContext(tools, [], hooks, new HarnessEventBus(), controller.signal),
    makeConfig(),
    streamForToolCall(call),
  );

  assert.deepEqual(seen.map(({ type }) => type), [
    "beforePrompt",
    "transformContext",
    "beforeTool",
    "transformContext",
  ]);
  assert.ok(seen.every(({ signal }) => signal === controller.signal));
});
