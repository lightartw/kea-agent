import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { runAgentLoop } from "../../src/core/harness/agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../../src/core/harness/types.js";
import type {
  AssistantMessage,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  StreamChunk,
} from "../../src/core/ai/types.js";
import type { TestStream } from "../fixtures/model-runtime.js";
import { AgentTool, type AgentToolResult } from "../../src/core/harness/tools/types.js";
import type { AgentToolCall } from "../../src/core/harness/tools/types.js";
import { AgentToolRegistry } from "../../src/core/harness/tools/registry.js";
import { HarnessEventBus } from "../../src/core/harness/events.js";
import { HarnessHooks } from "../../src/core/harness/hooks.js";

const emptyParameters = Type.Object({}, { additionalProperties: false });
const testModel: ModelConfig = { provider: "test", model: "test-model" };

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: testModel,
    convertToLlm: (msgs) => msgs,
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

class ThrowingTool extends AgentTool<typeof emptyParameters> {
  constructor() {
    super("throwing", "Throwing tool.", emptyParameters);
  }
  async execute(): Promise<AgentToolResult> {
    throw new Error("pipeline crashed");
  }
}

// ── Turn and Tool lifecycle ordering ──

test("successful two-Turn order matches the lifecycle", async () => {
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
  let turn = 0;
  const stream: TestStream = async function* () {
    turn += 1;
    if (turn === 1) {
      yield { type: "toolcall_start", id: "c1", name: "noop" };
      yield { type: "toolcall_end", toolCall: tc };
      yield { type: "done", message: assistantMsg("", [tc]) };
    } else {
      yield { type: "done", message: assistantMsg("done") };
    }
  };
  const events = new HarnessEventBus();
  const hooks = new HarnessHooks();
  const factOrder: string[] = [];
  events.on("turn-start", () => { factOrder.push("turn-start"); });
  events.on("turn-end", () => { factOrder.push("turn-end"); });
  events.on("tool-call", () => { factOrder.push("tool-call"); });
  events.on("tool-result", () => { factOrder.push("tool-result"); });
  hooks.on("beforeTool", () => { factOrder.push("beforeTool"); });

  await runAgentLoop(
    "run",
    memoryContext(registry, [], hooks, events),
    makeConfig(),
    stream,
  );

  assert.deepEqual(factOrder, [
    "turn-start",
    "tool-call",
    "beforeTool",
    "tool-result",
    "turn-end",
    "turn-start",
    "turn-end",
  ]);
});

test("tool-call is emitted once per model-requested call", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
  const tc1 = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  const tc2 = { type: "toolCall" as const, id: "c2", name: "noop", arguments: {} };
  let turn = 0;
  const stream: TestStream = async function* () {
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
  const events = new HarnessEventBus();
  const calls: AgentToolCall[] = [];
  events.on("tool-call", (event) => { calls.push(event.call); });

  await runAgentLoop(
    "run",
    memoryContext(registry, [], new HarnessHooks(), events),
    makeConfig(),
    stream,
  );

  assert.deepEqual(calls.map((call) => call.id), ["c1", "c2"]);
});

test("maxTurns stops before another model request", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "noop",
    arguments: {},
  };
  let requests = 0;
  const stream: TestStream = async function* () {
    requests += 1;
    yield { type: "toolcall_start", id: call.id, name: call.name };
    yield { type: "toolcall_end", toolCall: call };
    yield { type: "done", message: assistantMsg("", [call]) };
  };

  await runAgentLoop(
    "run",
    memoryContext(registry),
    makeConfig({ maxTurns: 1 }),
    stream,
  );

  assert.equal(requests, 1);
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
  const stream = streamWithEvents(
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
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    systemPrompt: "",
    messages: history,
    tools: registry,
    hooks: new HarnessHooks(),
    events: new HarnessEventBus(),
    appendMessage: async (message) => { history.push(message); },
  };

  await runAgentLoop("run", context, makeConfig(), stream);

  assert.deepEqual(secondHistory?.at(-1), {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "ok",
    isError: false,
  });
  assert.deepEqual(history.at(-1), assistantMsg(""));
});

test("tool-result is emitted only after its Tool message is appended", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new NoopTool());
  const history: AgentMessage[] = [];
  const events = new HarnessEventBus();
  const context: AgentContext = {
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    systemPrompt: "",
    messages: history,
    tools: registry,
    hooks: new HarnessHooks(),
    events,
    appendMessage: async (message) => { history.push(message); },
  };
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const checks: string[] = [];
  events.on("tool-result", (event) => {
    const committed = history.some((message) =>
      message.role === "tool" && message.toolCallId === "c1" &&
      message.content === event.result.content,
    );
    checks.push(`tool-result:${committed}`);
  });
  events.on("turn-end", (event) => {
    const committed = history.some((message) => message === event.message);
    checks.push(`turn-end:${committed}`);
  });

  await runAgentLoop(
    "run",
    context,
    makeConfig(),
    streamForToolCall(call),
  );

  assert.deepEqual(checks, ["tool-result:true", "turn-end:true", "turn-end:true"]);
});

// ── Tool failure invariants ──

test("unknown, invalid, blocked, and thrown tools each produce exactly one error result", async () => {
  const scenarios = [
    {
      label: "unknown",
      call: { type: "toolCall" as const, id: "c1", name: "missing", arguments: {} },
      register: () => undefined,
      configure: () => undefined,
    },
    {
      label: "invalid",
      call: { type: "toolCall" as const, id: "c2", name: "typed", arguments: { value: 1 } },
      register: (registry: AgentToolRegistry) => registry.register(new TypedTool()),
      configure: () => undefined,
    },
    {
      label: "blocked",
      call: { type: "toolCall" as const, id: "c3", name: "noop", arguments: {} },
      register: (registry: AgentToolRegistry) => registry.register(new NoopTool()),
      configure: (hooks: HarnessHooks) => {
        hooks.on("beforeTool", () => ({ kind: "deny", reason: "blocked" }));
      },
    },
    {
      label: "thrown",
      call: { type: "toolCall" as const, id: "c4", name: "throwing", arguments: {} },
      register: (registry: AgentToolRegistry) => registry.register(new ThrowingTool()),
      configure: () => undefined,
    },
  ];

  for (const scenario of scenarios) {
    const registry = new AgentToolRegistry();
    scenario.register(registry);
    const hooks = new HarnessHooks();
    scenario.configure(hooks);
    const history: AgentMessage[] = [];
    const context: AgentContext = {
      sessionId: "session-1",
      runId: "run-1",
      cwd: process.cwd(),
      systemPrompt: "",
      messages: history,
      tools: registry,
      hooks,
      events: new HarnessEventBus(),
      appendMessage: async (message) => { history.push(message); },
    };
    const results: AgentToolResult[] = [];
    context.events.on("tool-result", (event) => {
      results.push(event.result);
    });

    await runAgentLoop(
      "run",
      context,
      makeConfig(),
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

// ── Control hook failures ──

test("failing beforePrompt or transformContext hooks reject the Run", async () => {
  const cases: Array<{
    name: "beforePrompt" | "transformContext";
    register: (hooks: HarnessHooks) => void;
  }> = [
    {
      name: "beforePrompt",
      register: (hooks) => { hooks.on("beforePrompt", () => { throw new Error("beforePrompt failed"); }); },
    },
    {
      name: "transformContext",
      register: (hooks) => { hooks.on("transformContext", () => { throw new Error("transformContext failed"); }); },
    },
  ];
  for (const { name, register } of cases) {
    const hooks = new HarnessHooks();
    register(hooks);
    await assert.rejects(
      runAgentLoop(
        "start",
        memoryContext(undefined, [], hooks),
        makeConfig(),
        streamWithEvents([[{ type: "done", message: assistantMsg("") }]]),
      ),
      new RegExp(`${name} failed`),
    );
  }
});

// ── Stream edge cases ──

test("AI error terminal chunk appends its message and rejects", async () => {
  const events = new HarnessEventBus();
  const failed = {
    ...assistantMsg(""),
    stopReason: "error" as const,
    errorMessage: "provider failed",
  };
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    hooks: new HarnessHooks(),
    events,
    appendMessage: async (message) => { history.push(message); },
  };
  const turnEnds: Array<{ message: AgentMessage; toolResults: readonly AgentMessage[] }> = [];
  events.on("turn-end", (event) => { turnEnds.push(event); });

  await assert.rejects(
    runAgentLoop(
      "start",
      context,
      makeConfig(),
      streamWithEvents([[{ type: "error", message: failed }]]),
    ),
    /provider failed/,
  );

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0]?.message.role, "assistant");
  assert.deepEqual(turnEnds[0]?.toolResults, []);
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
});

test("pre-aborted run rejects with AbortError before model streaming", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runAgentLoop(
      "start",
      memoryContext(undefined, [], new HarnessHooks(), new HarnessEventBus(), controller.signal),
      makeConfig(),
      streamWithEvents([]),
    ),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("stream ending without a terminal chunk rejects and emits no turn-end", async () => {
  const events = new HarnessEventBus();
  const history: AgentMessage[] = [];
  const context: AgentContext = {
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    systemPrompt: "",
    messages: history,
    tools: new AgentToolRegistry(),
    hooks: new HarnessHooks(),
    events,
    appendMessage: async (message) => { history.push(message); },
  };
  let turnEnds = 0;
  events.on("turn-end", () => { turnEnds++; });

  await assert.rejects(
    runAgentLoop(
      "hello",
      context,
      makeConfig(),
      async function* () {},
    ),
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
  const stream: TestStream = async function* () {
    yield { type: "toolcall_start", id: "c1", name: "first" };
    yield { type: "toolcall_end", toolCall: tc1 };
    yield { type: "toolcall_start", id: "c2", name: "first" };
    yield { type: "toolcall_end", toolCall: tc2 };
    yield { type: "done", message: assistantMsg("", [tc1, tc2]) };
  };

  const history: AgentMessage[] = [];
  const events = new HarnessEventBus();
  const controller = new AbortController();
  const context: AgentContext = {
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    systemPrompt: "",
    messages: history,
    tools: registry,
    hooks: new HarnessHooks(),
    events,
    signal: controller.signal,
    appendMessage: async (message) => { history.push(message); },
  };
  const results: AgentToolResult[] = [];
  events.on("tool-result", (event) => {
    results.push(event.result);
  });

  const run = runAgentLoop(
    "run",
    context,
    makeConfig(),
    stream,
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
