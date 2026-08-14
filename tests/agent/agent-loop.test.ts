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

// ── Turn and Tool lifecycle ordering ──

test("successful two-Turn order matches the lifecycle", async () => {
  const observed: string[] = [];
  class NoopTool2 extends AgentTool<typeof emptyParameters> {
    constructor() {
      super("noop", "No-op tool.", emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      return { content: "ok", isError: false };
    }
  }
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool2());
  const tc = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  const streamFn: StreamFn = async function* () {
    if (observed.length === 0) {
      observed.push("first");
      yield { type: "toolcall_start", id: "c1", name: "noop" };
      yield { type: "toolcall_end", toolCall: tc };
      yield { type: "done", message: assistantMsg("", [tc]) };
    } else {
      yield { type: "done", message: assistantMsg("done") };
    }
  };
  const events = new Events();
  const factOrder: string[] = [];
  events.on("agent/turn-start", () => { factOrder.push("agent/turn-start"); });
  events.on("agent/turn-end", () => { factOrder.push("agent/turn-end"); });
  events.on("agent/tool-call", () => { factOrder.push("agent/tool-call"); });
  events.on("agent/tool-result", () => { factOrder.push("agent/tool-result"); });
  events.on("tools/pre-execute", (input, proceed) => { factOrder.push("tools/pre-execute"); return proceed(input); });
  events.on("tools/execute", (input, proceed) => { factOrder.push("tools/execute"); return proceed(input); });
  events.on("tools/post-execute", (input, proceed) => { factOrder.push("tools/post-execute"); return proceed(input); });
  events.on("agent/stopping", () => { factOrder.push("agent/stopping"); });

  await runAgentLoop("run", memoryContext(registry), makeConfig({ events }), streamFn);

  assert.deepEqual(factOrder, [
    "agent/turn-start",
    "agent/tool-call",
    "tools/pre-execute",
    "tools/execute",
    "tools/post-execute",
    "agent/tool-result",
    "agent/turn-end",
    "agent/turn-start",
    "agent/turn-end",
    "agent/stopping",
  ]);
});

test("agent/tool-call is emitted once per model-requested call", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
  const tc1 = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  const tc2 = { type: "toolCall" as const, id: "c2", name: "noop", arguments: {} };
  let turn = 0;
  const streamFn: StreamFn = async function* () {
    turn += 1;
    if (turn === 1) {
      yield { type: "toolcall_start", id: "c1", name: "noop" };
      yield { type: "toolcall_end", toolCall: tc1 };
      yield { type: "toolcall_start", id: "c2", name: "noop" };
      yield { type: "toolcall_end", toolCall: tc2 };
      yield { type: "done", message: assistantMsg("", [tc1, tc2]) };
    } else {
      yield { type: "done", message: assistantMsg("done") };
    }
  };
  const events = new Events();
  const calls: AgentToolCall[] = [];
  events.on("agent/tool-call", (input) => {
    if (input.sessionId === "session-1") calls.push(input.call);
  });

  await runAgentLoop("run", memoryContext(registry), makeConfig({ events }), streamFn);

  assert.deepEqual(calls.map((call) => call.id), ["c1", "c2"]);
});

test("tool results are in history before the next model stream", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new (class extends AgentTool<typeof emptyParameters> {
    constructor() {
      super("noop", "Run noop.", emptyParameters);
    }
    async execute(): Promise<AgentToolResult> {
      return { content: "ok", isError: false };
    }
  })());
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

test("agent/tool-result is emitted only after its Tool message is appended", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
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
  const events = new Events();
  const checks: string[] = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId !== "session-1") return;
    const committed = history.some((message) =>
      message.role === "tool" && message.toolCallId === "c1" &&
      message.content === input.result.content,
    );
    checks.push(`tool-result:${committed}`);
  });
  events.on("agent/turn-end", (input) => {
    if (input.sessionId !== "session-1") return;
    const committed = history.some((message) => message === input.message);
    checks.push(`turn-end:${committed}`);
  });

  await runAgentLoop("run", context, makeConfig({ events }), streamForToolCall(call));

  assert.deepEqual(checks, ["tool-result:true", "turn-end:true", "turn-end:true"]);
});

// ── Tool failure invariants ──

test("unknown, invalid, blocked, and thrown tools each produce exactly one error result", async () => {
  const scenarios = [
    {
      label: "unknown",
      call: { type: "toolCall" as const, id: "c1", name: "missing", arguments: {} },
      register: () => undefined,
      event: () => undefined,
    },
    {
      label: "invalid",
      call: { type: "toolCall" as const, id: "c2", name: "typed", arguments: { value: 1 } },
      register: (registry: AgentToolRegistry) => registry.register(new TypedTool()),
      event: () => undefined,
    },
    {
      label: "blocked",
      call: { type: "toolCall" as const, id: "c3", name: "noop", arguments: {} },
      register: (registry: AgentToolRegistry) => registry.register(new NoopTool()),
      event: (events: Events) => {
        events.on("tools/pre-execute", () => ({
          content: "Error: blocked",
          isError: true,
        }));
      },
    },
    {
      label: "thrown",
      call: { type: "toolCall" as const, id: "c4", name: "noop", arguments: {} },
      register: (registry: AgentToolRegistry) => registry.register(new NoopTool()),
      event: (events: Events) => {
        events.on("tools/execute", () => {
          throw new Error("pipeline crashed");
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    const registry = new AgentToolRegistry();
    scenario.register(registry);
    const events = new Events();
    scenario.event(events);
    const history: AgentMessage[] = [];
    const context: AgentContext = {
      systemPrompt: "",
      messages: history,
      tools: registry,
      appendMessage: async (message) => { history.push(message); },
    };
    const results: AgentToolResult[] = [];
    events.on("agent/tool-result", (input) => {
      if (input.sessionId === "session-1") results.push(input.result);
    });

    await runAgentLoop(
      "run",
      context,
      makeConfig({ events }),
      streamForToolCall(scenario.call),
    );

    assert.equal(results.length, 1, scenario.label);
    assert.equal(results[0]?.isError, true, scenario.label);
    assert.equal(
      history.filter((message) =>
        message.role === "tool" && message.toolCallId === scenario.call.id,
      ).length,
      1,
      scenario.label,
    );
  }
});

// ── Control interceptor failures ──

test("failing agent/user-prompt, agent/context, or agent/stopping interceptors reject the Run", async () => {
  const cases: Array<{
    name: "agent/user-prompt" | "agent/context" | "agent/stopping";
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
      name: "agent/stopping",
      register: (events) => { events.on("agent/stopping", () => { throw new Error("agent/stopping failed"); }); },
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

// ── Stream edge cases ──

test("AI error terminal chunk appends its message and finishes", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stopping", () => { stops++; });
  const failed = {
    ...assistantMsg(""),
    stopReason: "error" as const,
    errorMessage: "provider failed",
  };
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };
  const turnEnds: Array<{ message: AgentMessage; toolResults: readonly AgentMessage[] }> = [];
  events.on("agent/turn-end", (input) => {
    if (input.sessionId === "session-1") turnEnds.push(input);
  });

  await runAgentLoop(
    "start",
    context,
    makeConfig({ events }),
    streamFnWithEvents([[{ type: "error", message: failed }]]),
  );

  assert.equal(stops, 0);
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0]?.message.role, "assistant");
  assert.deepEqual(turnEnds[0]?.toolResults, []);
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
});

test("pre-aborted run rejects with AbortError without triggering stopping", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stopping", () => { stops++; });
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

test("stream ending without a terminal chunk rejects and emits no turn-end", async () => {
  const events = new Events();
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    appendMessage: async (message) => { history.push(message); },
  };
  let turnEnds = 0;
  events.on("agent/turn-end", (input) => {
    if (input.sessionId === "session-1") turnEnds++;
  });

  await assert.rejects(
    runAgentLoop("hello", context, makeConfig({ events }), async function* () {}),
    /stream.*terminal|done.*error/i,
  );
  assert.equal(turnEnds, 0);
  assert.deepEqual(
    history.map((message) => message.role),
    ["user"],
  );
});

// ── abort during execution ──

test("abort during execution still produces exactly one result per call", async () => {
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
  const tc2 = { type: "toolCall" as const, id: "c2", name: "first", arguments: {} };
  const streamFn: StreamFn = async function* () {
    yield { type: "toolcall_start", id: "c1", name: "first" };
    yield { type: "toolcall_end", toolCall: tc1 };
    yield { type: "toolcall_start", id: "c2", name: "first" };
    yield { type: "toolcall_end", toolCall: tc2 };
    yield { type: "done", message: assistantMsg("", [tc1, tc2]) };
  };

  const history: AgentMessage[] = [];
  const context: AgentContext = {
    systemPrompt: "",
    messages: history,
    tools: registry,
    appendMessage: async (message) => { history.push(message); },
  };
  const events = new Events();
  const results: AgentToolResult[] = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId === "session-1") results.push(input.result);
  });
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
  await assert.rejects(
    run,
    (error: unknown) => (error as Error).name === "AbortError",
  );

  assert.equal(results.length, 2);
  assert.equal(
    history.filter((message) => message.role === "tool").length,
    2,
  );
});
