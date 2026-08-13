import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../../src/agent/types.js";
import type {
  AssistantMessage,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  StreamChunk,
  StreamFn,
} from "../../src/ai/types.js";
import { AgentTool, type AgentToolResult } from "../../src/agent/tools/types.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
import { Events } from "../../src/events/events.js";

const run = { sessionId: "session-1", runId: "run-1", lane: "main" } as const;
const emptyParameters = Type.Object({}, { additionalProperties: false });
const testModel: ModelConfig = { provider: "test", model: "test-model" };

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: testModel,
    convertToLlm: (msgs) => msgs,
    events: new Events(),
    run,
    ...overrides,
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

function streamFnWithEvents(
  streams: readonly (readonly StreamChunk[])[],
  beforeStream?: (context: Context, index: number) => void,
): StreamFn {
  let index = 0;
  return async function* (_model, context) {
    const current = index;
    index += 1;
    beforeStream?.(context, current);
    for (const event of streams[current] ?? []) yield event;
  };
}

function memoryContext(tools = new AgentToolRegistry()): AgentContext {
  const messages: AgentMessage[] = [];
  return {
    systemPrompt: "",
    messages,
    tools,
    appendMessage: async (message) => { messages.push(message); },
  };
}

function makeListener(
  events: Events,
  names: readonly string[],
  factOrder: string[],
  onFact?: (name: string, input: unknown) => void,
): void {
  for (const name of names) {
    events.on(name as never, (input: unknown) => {
      factOrder.push(name);
      onFact?.(name, input);
    });
  }
}

test("runAgentLoop streams text and stores one complete assistant message", async () => {
  const final = assistantMsg("hello");
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };
  const streamFn = streamFnWithEvents([[
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "done", message: final },
  ]]);
  const events = new Events();
  const factOrder: string[] = [];
  makeListener(events, [
    "agent/turn-start",
    "agent/turn-end",
    "agent/text-delta",
    "agent/thinking-delta",
  ], factOrder);

  await runAgentLoop("hi", context, makeConfig({ events }), streamFn);

  assert.deepEqual(factOrder, [
    "agent/turn-start",
    "agent/text-delta",
    "agent/text-delta",
    "agent/turn-end",
  ]);
  assert.deepEqual(history.at(-1), final);
});

test("runAgentLoop streams and executes tools sequentially", async () => {
  const observed: string[] = [];
  class OrderedTool extends AgentTool<typeof emptyParameters> {
    constructor(name: string) {
      super(name, `Run ${name}.`, emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      observed.push(this.name);
      return { content: `${this.name} result`, isError: false };
    }
  }
  const registry = new AgentToolRegistry();
  registry.register(new OrderedTool("first"));
  registry.register(new OrderedTool("second"));
  const tc1 = { type: "toolCall" as const, id: "c1", name: "first", arguments: {} };
  const tc2 = { type: "toolCall" as const, id: "c2", name: "second", arguments: {} };
  const finalMsg = assistantMsg("finished");
  const streamFn: StreamFn = async function* (_model, _ctx, _opts) {
    if (observed.length === 0) {
      observed.push("done");
      yield { type: "toolcall_start", id: "c1", name: "first" };
      yield { type: "toolcall_end", toolCall: tc1 };
      yield { type: "toolcall_start", id: "c2", name: "second" };
      yield { type: "toolcall_end", toolCall: tc2 };
      yield { type: "done", message: assistantMsg("", [tc1, tc2]) };
    } else {
      yield { type: "text_delta", text: "finished" };
      yield { type: "done", message: finalMsg };
    }
  };
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: registry,
    appendMessage: async (message) => { history.push(message); },
  };
  const events = new Events();
  const factOrder: string[] = [];
  makeListener(events, [
    "agent/turn-start",
    "agent/turn-end",
    "agent/toolcall-start",
    "agent/toolcall-end",
    "agent/tool-start",
    "agent/tool-end",
    "agent/text-delta",
  ], factOrder);

  await runAgentLoop("run", context, makeConfig({ events }), streamFn);

  assert.deepEqual(observed, ["done", "first", "second"]);
  assert.deepEqual(factOrder, [
    "agent/turn-start",
    "agent/toolcall-start",
    "agent/toolcall-end",
    "agent/toolcall-start",
    "agent/toolcall-end",
    "agent/turn-end",
    "agent/tool-start",
    "agent/tool-end",
    "agent/tool-start",
    "agent/tool-end",
    "agent/turn-start",
    "agent/text-delta",
    "agent/turn-end",
  ]);
  assert.deepEqual(
    history.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
});

test("complete messages are persisted before their terminal facts", async () => {
  const tool = new (class extends AgentTool<typeof emptyParameters> {
    constructor() {
      super("noop", "No-op tool.", emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      return { content: "ok", isError: false };
    }
  })();
  const registry = new AgentToolRegistry();
  registry.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: registry,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const streamFn = streamFnWithEvents([
    [
      { type: "toolcall_start", id: "c1", name: "noop" },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("") }],
  ]);
  const events = new Events();
  const checks: string[] = [];

  events.on("agent/turn-end", (input) => {
    if (input.sessionId !== "session-1") return;
    const committed = history.some((message) => message === input.message);
    checks.push(`turn-end:${committed}`);
  });
  events.on("agent/tool-end", (input) => {
    if (input.sessionId !== "session-1") return;
    const committed = history.some((message) =>
      message.role === "tool" && message.toolCallId === "c1" &&
      message.content === input.result.content,
    );
    checks.push(`tool-end:${committed}`);
  });
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId !== "session-1") return;
    const committed = history.some((message) =>
      message.role === "tool" && message.toolCallId === "c1" &&
      message.content === input.result.content,
    );
    checks.push(`tool-rejected:${committed}`);
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamFn);

  assert.deepEqual(checks, ["turn-end:true", "tool-end:true", "turn-end:true"]);
});

test("tool results are in history before the next model stream", async () => {
  class NoopTool extends AgentTool<typeof emptyParameters> {
    constructor() {
      super("noop", "Run noop.", emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      return { content: "ok", isError: false };
    }
  }
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
  const tc = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  let secondHistory: readonly AgentMessage[] | undefined;
  const streamFn = streamFnWithEvents(
    [
      [
        { type: "toolcall_start", id: "c1", name: "noop" },
        { type: "toolcall_end", toolCall: tc },
        { type: "done", message: assistantMsg("", [tc]) },
      ],
      [{ type: "done", message: assistantMsg("") }],
    ],
    (context, index) => {
      if (index === 1) secondHistory = [...context.messages];
    },
  );
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: registry,
    appendMessage: async (message) => { history.push(message); },
  };

  await runAgentLoop("run", context, makeConfig(), streamFn);

  assert.deepEqual(secondHistory?.at(-1), {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "ok",
    isError: false,
  });
  assert.deepEqual(history.at(-1), assistantMsg(""));
});

test("Registry failures are rejected and returned to the model", async () => {
  const missingCall = { type: "toolCall" as const, id: "c1", name: "missing", arguments: {} };
  const streamFn = streamFnWithEvents([
    [
      { type: "toolcall_start", id: "c1", name: "missing" },
      { type: "toolcall_end", toolCall: missingCall },
      { type: "done", message: assistantMsg("", [missingCall]) },
    ],
    [{ type: "done", message: assistantMsg("recovered") }],
  ]);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };
  const events = new Events();
  const rejected: AgentToolResult[] = [];
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId === "session-1") rejected.push(input.result);
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamFn);

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.isError, true);
  assert.equal(rejected[0]?.content, "Error: Unknown tool 'missing'");
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "missing",
    content: "Error: Unknown tool 'missing'",
    isError: true,
  });
});

test("agent/user-prompt rejection prevents message insertion and model calls", async () => {
  const events = new Events();
  events.on("agent/user-prompt", () => ({ block: true, reason: "blocked" }));
  let streams = 0;
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };

  await runAgentLoop(
    "secret",
    context,
    makeConfig({ events }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg("unused") };
    },
  );

  assert.equal(streams, 0);
  assert.deepEqual(history, []);
});

test("agent/context transform reaches the model without replacing history", async () => {
  const events = new Events();
  events.on("agent/context", (input, next) => next({
    ...input,
    messages: [
      ...input.messages,
      { role: "user", content: "request-only" },
    ],
  }));
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };
  let requestMessages: readonly Message[] = [];

  await runAgentLoop(
    "real",
    context,
    makeConfig({ events }),
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

test("agent/stop continueWith appends a message and starts another turn", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stop", () => {
    stops++;
    return stops === 1
      ? { continueWith: { role: "user", content: "continue" } }
      : undefined;
  });
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };
  let streams = 0;

  await runAgentLoop(
    "start",
    context,
    makeConfig({ events }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg(`answer-${streams}`) };
    },
  );

  assert.equal(streams, 2);
  assert.equal(stops, 2);
  assert.deepEqual(history.map((message) => message.role), [
    "user", "assistant", "user", "assistant",
  ]);
  assert.equal(history[2]?.role === "user" ? history[2].content : "", "continue");
});

test("AI error does not trigger stop", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stop", () => { stops++; });
  const failed = {
    ...assistantMsg(""),
    stopReason: "error" as const,
    errorMessage: "provider failed",
  };
  const context = memoryContext();

  await runAgentLoop(
    "start",
    context,
    makeConfig({ events }),
    streamFnWithEvents([[{ type: "error", message: failed }]]),
  );
  assert.equal(stops, 0);
});

test("pre-aborted run rejects with AbortError without triggering stop", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stop", () => { stops++; });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runAgentLoop(
      "start",
      memoryContext(),
      makeConfig({ events }),
      streamFnWithEvents([]),
      controller.signal,
    ),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  assert.equal(stops, 0);
});

// ── Tool control tests ──

const typedParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

class TypedTool extends AgentTool<typeof typedParameters> {
  ran = false;
  seen = "";
  constructor() {
    super("typed", "Typed tool.", typedParameters);
  }
  async execute(
    arguments_: Static<typeof typedParameters>,
  ): Promise<AgentToolResult> {
    this.ran = true;
    this.seen = arguments_.value;
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

function streamForToolCall(call: AgentToolCall): StreamFn {
  return streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ]);
}

test("agent/tool-call can repair input before final TypeBox validation", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "typed",
    arguments: { value: 1 },
  };
  const events = new Events();
  events.on("agent/tool-call", (decision, next) => next({
    ...decision,
    call: { ...decision.call, arguments: { value: "fixed" } },
  }));
  const context = memoryContext(tools);

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));
  assert.equal(tool.ran, true);
  assert.equal(tool.seen, "fixed");
});

test("agent/tool-call mutation cannot bypass final TypeBox validation", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "typed",
    arguments: { value: "valid" },
  };
  const events = new Events();
  events.on("agent/tool-call", (decision, next) => next({
    ...decision,
    call: { ...decision.call, arguments: { value: 1 } },
  }));

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));
  assert.equal(tool.ran, false);
  const toolMessage = history.find((message) => message.role === "tool");
  assert.match(
    toolMessage?.role === "tool" ? toolMessage.content : "",
    /Invalid arguments for tool 'typed'/,
  );
});

test("agent/tool-call block false continues and block true creates an error result", async () => {
  class ObservedTool extends AgentTool<typeof emptyParameters> {
    ran = false;
    constructor() {
      super("noop", "No-op tool.", emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      this.ran = true;
      return { content: "ran", isError: false };
    }
  }
  const tool = new ObservedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "noop",
    arguments: {},
  };
  const events = new Events();
  const calls: string[] = [];
  events.on("agent/tool-call", (decision, next) => {
    calls.push("observed");
    return next(decision);
  });
  events.on("agent/tool-call", (decision) => ({
    ...decision,
    kind: "reject" as const,
    call: decision.call,
    reason: "denied",
  }));

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));
  const toolMessage = history.find((message) => message.role === "tool");
  assert.deepEqual(calls, ["observed"]);
  assert.equal(tool.ran, false);
  assert.equal(
    toolMessage?.role === "tool" ? toolMessage.content : "",
    "Error: denied",
  );
});

test("agent/tool-result transformed result is identical in tool message and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-result", (input, next) => next({
    ...input,
    result: { content: "patched", isError: true },
  }));
  let secondRequest: readonly Message[] = [];
  const stream = streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ], (context, index) => {
    if (index === 1) secondRequest = [...context.messages];
  });
  const toolEnds: AgentToolResult[] = [];
  events.on("agent/tool-end", (input) => {
    if (input.sessionId === "session-1") toolEnds.push(input.result);
  });

  await runAgentLoop("run", context, makeConfig({ events }), stream);

  assert.deepEqual(toolEnds[0], { content: "patched", isError: true });
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "patched",
    isError: true,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("agent/tool-call listener failure blocks execution", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-call", () => {
    throw new Error("permission crashed");
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));
  assert.equal(tool.ran, false);
  assert.equal(
    history[2]?.role === "tool" ? history[2].content : "",
    "Error: tool_call listener failed: permission crashed",
  );
});

test("agent/tool-result listener failure becomes an error result", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-result", () => {
    throw new Error("post hook crashed");
  });
  let secondRequest: readonly Message[] = [];
  const stream = streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ], (context, index) => {
    if (index === 1) secondRequest = [...context.messages];
  });
  const toolEnds: AgentToolResult[] = [];
  events.on("agent/tool-end", (input) => {
    if (input.sessionId === "session-1") toolEnds.push(input.result);
  });

  await runAgentLoop("run", context, makeConfig({ events }), stream);

  const expected = {
    content: "Error: tool_result listener failed: post hook crashed",
    isError: true,
  };
  assert.deepEqual(toolEnds[0], expected);
  assert.equal(history[2]?.role, "tool");
  if (history[2]?.role !== "tool") return;
  assert.deepEqual(
    { content: history[2].content, isError: history[2].isError },
    expected,
  );
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("the same AbortSignal reaches every control listener", async () => {
  const events = new Events();
  const seen: Array<{ type: string; signal: AbortSignal | undefined }> = [];
  events.on("agent/user-prompt", (_input, signal) => {
    seen.push({ type: "user_prompt", signal });
  });
  events.on("agent/context", (input, next, signal) => {
    seen.push({ type: "context", signal });
    return next(input);
  });
  events.on("agent/tool-call", (decision, next, signal) => {
    seen.push({ type: "tool_call", signal });
    return next(decision);
  });
  events.on("agent/tool-result", (input, next, signal) => {
    seen.push({ type: "tool_result", signal });
    return next(input);
  });
  events.on("agent/stop", (_input, signal) => {
    seen.push({ type: "stop", signal });
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
    { ...memoryContext(), tools },
    makeConfig({ events }),
    streamForToolCall(call),
    controller.signal,
  );

  assert.deepEqual(seen.map(({ type }) => type), [
    "user_prompt",
    "context",
    "tool_call",
    "tool_result",
    "context",
    "stop",
  ]);
  assert.ok(seen.every(({ signal }) => signal === controller.signal));
});

test("successful execution ordering is tool-call → prepare → start → execute → result → end", async () => {
  const trace: string[] = [];
  class TraceTool extends AgentTool<typeof typedParameters> {
    constructor() {
      super("typed", "Typed tool.", typedParameters);
    }
    override validate(arguments_: unknown): string | undefined {
      trace.push(`validate:${(arguments_ as { value?: unknown }).value}`);
      return super.validate(arguments_);
    }
    async execute(arguments_: Static<typeof typedParameters>): Promise<AgentToolResult> {
      trace.push(`execute:${arguments_.value}`);
      return { content: arguments_.value, isError: false };
    }
  }
  const tools = new AgentToolRegistry();
  tools.register(new TraceTool());
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "typed", arguments: { value: "original" },
  };
  const events = new Events();
  events.on("agent/tool-call", (decision, next) => {
    trace.push("event:tool-call");
    return next({
      ...decision,
      call: { ...decision.call, arguments: { value: "changed" } },
    });
  });
  events.on("agent/tool-result", (input, next) => {
    trace.push(`event:tool-result:${input.result.content}`);
    return next(input);
  });
  events.on("agent/tool-start", (input) => {
    trace.push(`event:tool_start:${(input.call.arguments as { value: string }).value}`);
  });
  events.on("agent/tool-end", (input) => {
    trace.push(`event:tool_end:${input.result.content}`);
  });

  await runAgentLoop(
    "run",
    memoryContext(tools),
    makeConfig({ events }),
    streamForToolCall(call),
  );

  assert.deepEqual(trace, [
    "event:tool-call",
    "validate:changed",
    "event:tool_start:changed",
    "execute:changed",
    "event:tool-result:changed",
    "event:tool_end:changed",
  ]);
});

test("agent/tool-result details reach event, history, and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-result", (input, next) => next({
    ...input,
    result: {
      content: "Current tasks:\n1. [completed] tested",
      details: { todos: [{ content: "tested", status: "completed" }] },
      isError: false,
    },
  }));
  let secondRequest: readonly Message[] = [];
  const stream = streamFnWithEvents([
    [
      { type: "toolcall_start", id: call.id, name: call.name },
      { type: "toolcall_end", toolCall: call },
      { type: "done", message: assistantMsg("", [call]) },
    ],
    [{ type: "done", message: assistantMsg("done") }],
  ], (context, index) => {
    if (index === 1) secondRequest = [...context.messages];
  });
  const toolEnds: Array<{ result: AgentToolResult }> = [];
  events.on("agent/tool-end", (input) => {
    if (input.sessionId === "session-1") toolEnds.push({ result: input.result });
  });

  await runAgentLoop("run", context, makeConfig({ events }), stream);

  const expected = {
    content: "Current tasks:\n1. [completed] tested",
    details: { todos: [{ content: "tested", status: "completed" }] },
    isError: false,
  };
  assert.deepEqual(toolEnds[0]?.result, expected);
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    ...expected,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("tool_rejected.call.arguments stays the original object after listener change", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const originalArguments = { value: "valid" };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "typed", arguments: originalArguments,
  };
  const events = new Events();
  events.on("agent/tool-call", (decision, next) => next({
    ...decision,
    call: { ...decision.call, arguments: { value: 123 } },
  }));
  const context = memoryContext(tools);

  const rejected: Array<{
    call: AgentToolCall;
    effectiveArguments: Readonly<Record<string, unknown>> | undefined;
    reason: string;
  }> = [];
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId !== "session-1") return;
    rejected.push({
      call: input.call,
      effectiveArguments: input.effectiveArguments,
      reason: input.reason,
    });
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason, "invalid");
  assert.equal(rejected[0]?.call.arguments, originalArguments);
  assert.deepEqual(rejected[0]?.call.arguments, { value: "valid" });
  assert.deepEqual(rejected[0]?.effectiveArguments, { value: 123 });
});

test("blocked, invalid, and unknown each produce exactly one tool-rejected", async () => {
  const scenarios = [
    {
      label: "blocked",
      call: { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} },
      register: (registry: AgentToolRegistry) => registry.register(new NoopTool()),
      event: (events: Events) => {
        events.on("agent/tool-call", (decision) => ({
          ...decision,
          kind: "reject" as const,
          call: decision.call,
          reason: "nope",
        }));
      },
    },
    {
      label: "invalid",
      call: { type: "toolCall" as const, id: "c2", name: "typed", arguments: { value: 1 } },
      register: (registry: AgentToolRegistry) => registry.register(new TypedTool()),
      event: () => undefined,
    },
    {
      label: "unknown",
      call: { type: "toolCall" as const, id: "c3", name: "missing", arguments: {} },
      register: () => undefined,
      event: () => undefined,
    },
  ];

  for (const scenario of scenarios) {
    const registry = new AgentToolRegistry();
    scenario.register(registry);
    const events = new Events();
    let afterToolCallCount = 0;
    events.on("agent/tool-result", (input, next) => {
      afterToolCallCount++;
      return next(input);
    });
    scenario.event(events);
    const history: AgentMessage[] = [];
    const context: AgentContext = {
      systemPrompt: "",
      messages: history,
      tools: registry,
      appendMessage: async (message) => { history.push(message); },
    };
    const facts: string[] = [];
    makeListener(events, [
      "agent/tool-start",
      "agent/tool-end",
      "agent/tool-rejected",
    ], facts);

    await runAgentLoop(
      "run",
      context,
      makeConfig({ events }),
      streamForToolCall(scenario.call),
    );

    assert.equal(
      facts.filter((name) => name === "agent/tool-start").length, 0, scenario.label,
    );
    assert.equal(
      facts.filter((name) => name === "agent/tool-end").length, 0, scenario.label,
    );
    assert.equal(
      facts.filter((name) => name === "agent/tool-rejected").length, 1, scenario.label,
    );
    assert.equal(
      history.filter((message) =>
        message.role === "tool" && message.toolCallId === scenario.call.id,
      ).length,
      1,
      scenario.label,
    );
    assert.equal(afterToolCallCount, 0, scenario.label);
  }
});

test("abort during first execution produces tool-end then aborted rejections", async () => {
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  class AbortTool extends AgentTool<typeof emptyParameters> {
    constructor() {
      super("first", "Run first.", emptyParameters);
    }
    async execute(
      _arguments_: Static<typeof emptyParameters>,
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      resolveStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { content: "Error: aborted", isError: true };
    }
  }
  const registry = new AgentToolRegistry();
  registry.register(new AbortTool());

  const tc1 = { type: "toolCall" as const, id: "c1", name: "first", arguments: {} };
  const tc2 = { type: "toolCall" as const, id: "c2", name: "second", arguments: {} };
  const tc3 = { type: "toolCall" as const, id: "c3", name: "third", arguments: {} };
  const streamFn: StreamFn = async function* () {
    yield { type: "toolcall_start", id: "c1", name: "first" };
    yield { type: "toolcall_end", toolCall: tc1 };
    yield { type: "toolcall_start", id: "c2", name: "second" };
    yield { type: "toolcall_end", toolCall: tc2 };
    yield { type: "toolcall_start", id: "c3", name: "third" };
    yield { type: "toolcall_end", toolCall: tc3 };
    yield { type: "done", message: assistantMsg("", [tc1, tc2, tc3]) };
  };

  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: registry,
    appendMessage: async (message) => { history.push(message); },
  };
  const events = new Events();
  const facts: string[] = [];
  makeListener(events, [
    "agent/tool-start",
    "agent/tool-end",
    "agent/tool-rejected",
  ], facts);
  const controller = new AbortController();

  const run = runAgentLoop(
    "run",
    context,
    makeConfig({ events }),
    streamFn,
    controller.signal,
  );

  await started;
  controller.abort();
  await run;

  assert.equal(facts.filter((name) => name === "agent/tool-start").length, 1);
  assert.equal(facts.filter((name) => name === "agent/tool-end").length, 1);
  const rejected = facts.filter((name) => name === "agent/tool-rejected");
  assert.equal(rejected.length, 2);
  assert.equal(
    history.filter((message) => message.role === "tool").length,
    3,
  );
});

test("run abort wins over a permission confirm returning false", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  let hookEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { hookEntered = resolve; });
  const events = new Events();
  events.on("agent/tool-call", async (decision, _next, signal) => {
    hookEntered();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return {
      ...decision,
      kind: "reject" as const,
      call: decision.call,
      reason: "permission denied by user",
    };
  });
  const context = memoryContext();
  const rejected: Array<{ reason: string }> = [];
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId === "session-1") rejected.push({ reason: input.reason });
  });

  const controller = new AbortController();
  const run = runAgentLoop(
    "run",
    { ...context, tools },
    makeConfig({ events }),
    streamForToolCall(call),
    controller.signal,
  );

  await entered;
  controller.abort();
  await run;

  assert.equal(tool.ran, false);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason, "aborted");
});

// ── Task 5: failure matrix ──

test("an emit listener can throw while the next listener still runs and the Run completes", async () => {
  const events = new Events();
  const calls: string[] = [];
  events.on("agent/text-delta", (input) => {
    if (input.sessionId !== "session-1") return;
    calls.push("first");
    throw new Error("listener failed");
  });
  events.on("agent/text-delta", (input) => {
    if (input.sessionId === "session-1") calls.push("second");
  });

  await runAgentLoop(
    "hi",
    memoryContext(),
    makeConfig({ events }),
    streamFnWithEvents([[
      { type: "text_delta", text: "hel" },
      { type: "done", message: assistantMsg("hello") },
    ]]),
  );

  assert.deepEqual(calls, ["first", "second"]);
});

test("user-prompt, context, and stop listener failures reject the Run", async () => {
  const cases: Array<{
    name: "agent/user-prompt" | "agent/context" | "agent/stop";
    register: (events: Events) => void;
  }> = [
    {
      name: "agent/user-prompt",
      register: (events) => { events.on("agent/user-prompt", () => { throw new Error("agent/user-prompt failed"); }); },
    },
    {
      name: "agent/context",
      register: (events) => { events.on("agent/context", () => { throw new Error("agent/context failed"); }); },
    },
    {
      name: "agent/stop",
      register: (events) => { events.on("agent/stop", () => { throw new Error("agent/stop failed"); }); },
    },
  ];
  for (const { name, register } of cases) {
    const events = new Events();
    register(events);
    await assert.rejects(
      runAgentLoop("start", memoryContext(), makeConfig({ events }), streamFnWithEvents([[{ type: "done", message: assistantMsg("") }]])),
      new RegExp(`${name} failed`),
    );
  }
});

test("tool-call listener failure never executes the Tool and persists a rejected result", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-call", () => { throw new Error("crashed"); });
  const rejected: Array<{ reason: string }> = [];
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId === "session-1") rejected.push({ reason: input.reason });
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));

  assert.equal(tool.ran, false);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason, "blocked");
  const persisted = history.find((message) =>
    message.role === "tool" && message.toolCallId === "c1",
  );
  assert.match(persisted?.role === "tool" ? persisted.content : "", /crashed/);
});

test("tool-result listener failure persists and emits an error Tool Result", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-result", () => { throw new Error("post crashed"); });
  const toolEnds: Array<{ isError: boolean }> = [];
  events.on("agent/tool-end", (input) => {
    if (input.sessionId === "session-1") toolEnds.push({ isError: input.result.isError });
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));

  assert.deepEqual(toolEnds, [{ isError: true }]);
  const persisted = history.find((message) =>
    message.role === "tool" && message.toolCallId === "c1",
  );
  assert.equal(persisted?.role === "tool" ? persisted.isError : undefined, true);
});
