import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../../src/agent/types.js";
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

function emptyEvents(): Events {
  return new Events();
}

/** Minimal AgentLoopConfig with identity convertToLlm for test callers. */
function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: testModel,
    convertToLlm: (msgs) => msgs,
    events: emptyEvents(),
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

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("runAgentLoop streams text and stores one complete assistant message", async () => {
  const final = assistantMsg("hello");
  const history: AgentMessage[] = [];
  const streamFn = streamFnWithEvents([[
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "done", message: final },
  ]]);

  const events = await collect(
    runAgentLoop(
      "hi",
      { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
      makeConfig(),
      streamFn,
    ),
  );

  assert.deepEqual(events, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "turn_end", message: final },
    { type: "agent_end", messages: [...history] },
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

  const events = await collect(
    runAgentLoop(
      "run",
      { systemPrompt: "", messages: history, tools: registry },
      makeConfig(),
      streamFn,
    ),
  );

  assert.deepEqual(observed, ["done", "first", "second"]);
  assert.deepEqual(events.map((event) => event.type), [
    "agent_start",
    "turn_start",
    "toolcall_start",
    "toolcall_end",
    "toolcall_start",
    "toolcall_end",
    "turn_end",
    "tool_start",
    "tool_end",
    "tool_start",
    "tool_end",
    "turn_start",
    "text_delta",
    "turn_end",
    "agent_end",
  ]);
  assert.deepEqual(
    events.at(-1),
    { type: "agent_end", messages: [...history] },
  );
  assert.deepEqual(
    history.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
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

  await collect(
    runAgentLoop(
      "run",
      { systemPrompt: "", messages: history, tools: registry },
      makeConfig(),
      streamFn,
    ),
  );

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

  const events = await collect(
    runAgentLoop(
      "run",
      { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
      makeConfig(),
      streamFn,
    ),
  );

  const rejected = events.find((event) => event.type === "tool_rejected");
  assert.equal(rejected?.type, "tool_rejected");
  if (rejected?.type !== "tool_rejected") return;
  assert.equal(rejected.reason, "unknown");
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.content, "Error: Unknown tool 'missing'");
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "missing",
    content: "Error: Unknown tool 'missing'",
    isError: true,
  });
});

test("onBeforeTool blocks tool execution and returns error", async () => {
  class ObservedTool extends AgentTool<typeof emptyParameters> {
    ran = false;
    constructor() { super("noop", "Run noop.", emptyParameters); }
    async execute() { this.ran = true; return { content: "ok", isError: false }; }
  }
  const tool = new ObservedTool();
  const registry = new AgentToolRegistry();
  registry.register(tool);
  const tc = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  const streamFn = streamFnWithEvents([
    [
      { type: "toolcall_start", id: "c1", name: "noop" },
      { type: "toolcall_end", toolCall: tc },
      { type: "done", message: assistantMsg("", [tc]) },
    ],
    [{ type: "done", message: assistantMsg("") }],
  ]);
  const history: AgentMessage[] = [];
  const events = new Events();
  events.on("agent/tool-call", (decision) => ({
    ...decision,
    kind: "reject" as const,
    call: decision.call,
    reason: "blocked by test",
  }));
  const config = makeConfig({ events });

  await collect(
    runAgentLoop(
      "run",
      { systemPrompt: "", messages: history, tools: registry },
      config,
      streamFn,
    ),
  );

  assert.equal(tool.ran, false);
  assert.equal(history[2]?.content, "Error: blocked by test");
});

test("onBeforeTool failure blocks tool execution", async () => {
  class ObservedTool extends AgentTool<typeof emptyParameters> {
    ran = false;
    constructor() { super("noop", "Run noop.", emptyParameters); }
    async execute() { this.ran = true; return { content: "ok", isError: false }; }
  }
  const tool = new ObservedTool();
  const registry = new AgentToolRegistry();
  registry.register(tool);
  const tc = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  const streamFn = streamFnWithEvents([
    [
      { type: "toolcall_start", id: "c1", name: "noop" },
      { type: "toolcall_end", toolCall: tc },
      { type: "done", message: assistantMsg("", [tc]) },
    ],
    [{ type: "done", message: assistantMsg("") }],
  ]);
  const history: AgentMessage[] = [];
  const events = new Events();
  events.on("agent/tool-call", () => {
    throw new Error("boom");
  });
  const config = makeConfig({ events });

  await collect(
    runAgentLoop(
      "run",
      { systemPrompt: "", messages: history, tools: registry },
      config,
      streamFn,
    ),
  );

  assert.equal(tool.ran, false);
  const content = history[2]?.role === "tool" ? history[2].content : "";
  assert.match(content, /boom/);
});

// ── Task 2: user_prompt, context, stop tests ──

test("user_prompt block prevents history and model access", async () => {
  const events = new Events();
  events.on("agent/user-prompt", () => ({
    block: true,
    reason: "blocked",
  }));
  let streams = 0;
  const history: AgentMessage[] = [];
  const emitted = await collect(runAgentLoop(
    "secret",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ events }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg("unused") };
    },
  ));

  assert.equal(streams, 0);
  assert.deepEqual(history, []);
  assert.deepEqual(emitted, [
    { type: "agent_start" },
    { type: "agent_end", messages: [] },
  ]);
});

test("context hook changes one request without replacing real history", async () => {
  const events = new Events();
  events.on("agent/context", (input, next) => next({
    ...input,
    messages: [
      ...input.messages,
      { role: "user", content: "request-only" },
    ],
  }));
  const history: AgentMessage[] = [];
  let requestMessages: readonly Message[] = [];
  await collect(runAgentLoop(
    "real",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ events }),
    async function* (_model, context) {
      requestMessages = [...context.messages];
      yield { type: "done", message: assistantMsg("done") };
    },
  ));

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

test("stop continueWith appends a message and starts another turn", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stop", () => {
    stops++;
    return stops === 1
      ? { continueWith: { role: "user", content: "continue" } }
      : undefined;
  });
  const history: AgentMessage[] = [];
  let streams = 0;
  await collect(runAgentLoop(
    "start",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ events }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg(`answer-${streams}`) };
    },
  ));

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

  await collect(runAgentLoop(
    "start",
    {
      systemPrompt: "",
      messages: [],
      tools: new AgentToolRegistry(),
    },
    makeConfig({ events }),
    streamFnWithEvents([[{ type: "error", message: failed }]]),
  ));
  assert.equal(stops, 0);
});

test("pre-aborted run rejects with AbortError without triggering stop", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stop", () => { stops++; });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    collect(runAgentLoop(
      "start",
      {
        systemPrompt: "",
        messages: [],
        tools: new AgentToolRegistry(),
      },
      makeConfig({ events }),
      streamFnWithEvents([]),
      controller.signal,
    )),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  assert.equal(stops, 0);
});

// ── Task 3: Tool hook tests ──

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

test("tool_call can repair input before final TypeBox validation", async () => {
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

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ events }),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, true);
  assert.equal(tool.seen, "fixed");
});

test("tool_call mutation cannot bypass final TypeBox validation", async () => {
  const tool = new TypedTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
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

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ events }),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, false);
  const toolMessage = history.find((message) => message.role === "tool");
  assert.match(
    toolMessage?.role === "tool" ? toolMessage.content : "",
    /Invalid arguments for tool 'typed'/,
  );
});

test("tool_call block false continues and block true creates an error result", async () => {
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

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ events }),
    streamForToolCall(call),
  ));
  const toolMessage = history.find((message) => message.role === "tool");
  assert.deepEqual(calls, ["observed"]);
  assert.equal(tool.ran, false);
  assert.equal(
    toolMessage?.role === "tool" ? toolMessage.content : "",
    "Error: denied",
  );
});

test("tool_result Hook result is identical in event history and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "noop",
    arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-result", (input, next) => next({
    ...input,
    result: {
      content: "patched",
      isError: true,
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

  const eventsOut = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ events }),
    stream,
  ));
  const toolEnd = eventsOut.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.deepEqual(toolEnd.result, {
    content: "patched",
    isError: true,
  });
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "patched",
    isError: true,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("tool_call Hook failure blocks execution", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-call", () => {
    throw new Error("permission crashed");
  });

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ events }),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, false);
  assert.equal(
    history[2]?.role === "tool" ? history[2].content : "",
    "Error: tool_call listener failed: permission crashed",
  );
});

test("tool_result Hook failure replaces event history and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
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

  const eventsOut = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ events }),
    stream,
  ));
  const expected = {
    content: "Error: tool_result listener failed: post hook crashed",
    isError: true,
  };
  const toolEnd = eventsOut.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.deepEqual(toolEnd.result, expected);
  assert.equal(history[2]?.role, "tool");
  if (history[2]?.role !== "tool") return;
  assert.deepEqual(
    { content: history[2].content, isError: history[2].isError },
    expected,
  );
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("Agent run signal reaches every Hook trigger", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
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
  const controller = new AbortController();

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ events }),
    streamForToolCall(call),
    controller.signal,
  ));
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

// ── Task 4: terminal lifecycle tests ──

test("successful execution ordering is hook → prepare → start → execute → after → end", async () => {
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
    trace.push("hook:before");
    return next({
      ...decision,
      call: { ...decision.call, arguments: { value: "changed" } },
    });
  });
  events.on("agent/tool-result", (input, next) => {
    trace.push(`hook:after:${input.result.content}`);
    return next(input);
  });

  for await (const event of runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ events }),
    streamForToolCall(call),
  )) {
    if (event.type === "tool_start") {
      trace.push(`event:tool_start:${(event.call.arguments as { value: string }).value}`);
    } else if (event.type === "tool_end") {
      trace.push(`event:tool_end:${event.result.content}`);
    }
  }

  assert.deepEqual(trace, [
    "hook:before",
    "validate:changed",
    "event:tool_start:changed",
    "execute:changed",
    "hook:after:changed",
    "event:tool_end:changed",
  ]);
});

test("AfterToolCallResult details reach event, history, and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
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

  const eventsOut = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig({ events }),
    stream,
  ));

  const expected = {
    content: "Current tasks:\n1. [completed] tested",
    details: { todos: [{ content: "tested", status: "completed" }] },
    isError: false,
  };
  const toolEnd = eventsOut.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.deepEqual(toolEnd.result, expected);
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    ...expected,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

test("tool_rejected.call.arguments stays the original object after hook mutation", async () => {
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

  const eventsOut = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ events }),
    streamForToolCall(call),
  ));

  const rejected = eventsOut.find((event) => event.type === "tool_rejected");
  assert.equal(rejected?.type, "tool_rejected");
  if (rejected?.type !== "tool_rejected") return;
  assert.equal(rejected.reason, "invalid");
  assert.equal(rejected.call.arguments, originalArguments);
  assert.deepEqual(rejected.call.arguments, { value: "valid" });
  assert.deepEqual(rejected.effectiveArguments, { value: 123 });
});

test("blocked, invalid, and unknown each produce exactly one tool_rejected", async () => {
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

    const emitted = await collect(runAgentLoop(
      "run",
      { systemPrompt: "", messages: history, tools: registry },
      makeConfig({ events }),
      streamForToolCall(scenario.call),
    ));

    assert.equal(
      emitted.filter((event) => event.type === "tool_start").length, 0, scenario.label,
    );
    assert.equal(
      emitted.filter((event) => event.type === "tool_end").length, 0, scenario.label,
    );
    assert.equal(
      emitted.filter((event) => event.type === "tool_rejected").length, 1, scenario.label,
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

test("abort during first execution produces tool_end then aborted rejections", async () => {
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
  const controller = new AbortController();
  const run = collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools: registry },
    makeConfig(),
    streamFn,
    controller.signal,
  ));

  await started;
  controller.abort();
  const events = await run;

  assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_end").length, 1);
  const rejected = events.filter((event) => event.type === "tool_rejected");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((event) =>
    event.type === "tool_rejected" && event.reason === "aborted",
  ));
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

  const controller = new AbortController();
  const run = collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig({ events }),
    streamForToolCall(call),
    controller.signal,
  ));

  await entered;
  controller.abort();
  const emitted = await run;

  const rejected = emitted.find((event) => event.type === "tool_rejected");
  assert.equal(rejected?.type, "tool_rejected");
  if (rejected?.type !== "tool_rejected") return;
  assert.equal(rejected.reason, "aborted");
  assert.equal(tool.ran, false);
});
