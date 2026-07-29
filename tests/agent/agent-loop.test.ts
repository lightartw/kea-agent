import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../../src/agent/types.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";
import { AgentTool, type AgentToolResult } from "../../src/agent/tools/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
import { HookRegistry } from "../../src/agent/hooks/registry.js";
import type { AgentHookEvent } from "../../src/agent/hooks/types.js";

const emptyParameters = Type.Object({}, { additionalProperties: false });
const testModel: ModelConfig = { provider: "test", model: "test-model" };

function emptyHooks(): HookRegistry<AgentHookEvent, Record<string, never>> {
  return new HookRegistry<AgentHookEvent, Record<string, never>>({});
}

/** Minimal AgentLoopConfig with identity convertToLlm for test callers. */
function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: testModel,
    convertToLlm: (msgs) => msgs,
    hooks: emptyHooks(),
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
  streams: readonly (readonly AssistantMessageEvent[])[],
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

test("Registry failures are emitted and returned to the model", async () => {
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

  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.equal(toolEnd.result.isError, true);
  assert.equal(toolEnd.result.content, "Error: Unknown tool 'missing'");
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
  const hooks = emptyHooks();
  hooks.register("tool_call", async () => ({ block: true, reason: "blocked by test" }) as const);
  const config = makeConfig({ hooks });

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
  const hooks = emptyHooks();
  hooks.register("tool_call", async () => { throw new Error("boom"); });
  const config = makeConfig({ hooks });

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
  const hooks = emptyHooks();
  hooks.register("user_prompt", () => ({
    block: true,
    reason: "blocked",
  }));
  let streams = 0;
  const history: AgentMessage[] = [];
  const events = await collect(runAgentLoop(
    "secret",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ hooks }),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg("unused") };
    },
  ));

  assert.equal(streams, 0);
  assert.deepEqual(history, []);
  assert.deepEqual(events, [
    { type: "agent_start" },
    { type: "agent_end", messages: [] },
  ]);
});

test("context hook changes one request without replacing real history", async () => {
  const hooks = emptyHooks();
  hooks.register("context", ({ messages }) => ({
    messages: [
      ...messages,
      { role: "user", content: "request-only" },
    ],
  }));
  const history: AgentMessage[] = [];
  let requestMessages: readonly Message[] = [];
  await collect(runAgentLoop(
    "real",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig({ hooks }),
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
  const hooks = emptyHooks();
  let stops = 0;
  hooks.register("stop", () => {
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
    makeConfig({ hooks }),
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
  const hooks = emptyHooks();
  let stops = 0;
  hooks.register("stop", () => { stops++; });
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
    makeConfig({ hooks }),
    streamFnWithEvents([[{ type: "error", message: failed }]]),
  ));
  assert.equal(stops, 0);
});

test("pre-aborted run does not trigger stop", async () => {
  const hooks = emptyHooks();
  let stops = 0;
  hooks.register("stop", () => { stops++; });
  const controller = new AbortController();
  controller.abort();

  await collect(runAgentLoop(
    "start",
    {
      systemPrompt: "",
      messages: [],
      tools: new AgentToolRegistry(),
    },
    makeConfig({ hooks }),
    streamFnWithEvents([]),
    controller.signal,
  ));
  assert.equal(stops, 0);
});
