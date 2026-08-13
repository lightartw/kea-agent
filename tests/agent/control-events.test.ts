import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
} from "../../src/agent/types.js";
import { Events } from "../../src/events/events.js";
import { AgentTool, type AgentToolResult } from "../../src/agent/tools/types.js";
import type { AgentToolCall } from "../../src/agent/tools/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
import type {
  AssistantMessage,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  StreamChunk,
  StreamFn,
} from "../../src/ai/types.js";

const run = { sessionId: "session-1", runId: "run-1", lane: "main" } as const;

const emptyParameters = Type.Object({}, { additionalProperties: false });
const typedParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);
const testModel: ModelConfig = { provider: "test", model: "test-model" };

function makeConfig(events: Events): AgentLoopConfig {
  return {
    model: testModel,
    convertToLlm: (msgs) => msgs,
    events,
    run,
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

// ── agent/user-prompt ──

test("agent/user-prompt rejection prevents message insertion and model calls", async () => {
  const events = new Events();
  events.on("agent/user-prompt", () => ({ block: true, reason: "blocked" }));
  let streams = 0;
  const history: AgentMessage[] = [];

  const emitted = await collect(runAgentLoop(
    "secret",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig(events),
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

// ── agent/context ──

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
  let requestMessages: readonly Message[] = [];

  await collect(runAgentLoop(
    "real",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig(events),
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

// ── agent/tool-call ──

test("agent/tool-call transform can replace arguments", async () => {
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
    makeConfig(events),
    streamForToolCall(call),
  ));
  assert.equal(tool.ran, true);
  assert.equal(tool.seen, "fixed");
});

test("agent/tool-call terminal rejection blocks execution", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("agent/tool-call", (decision) => ({
    ...decision,
    kind: "reject" as const,
    call: decision.call,
    reason: "denied by policy",
  }));

  const emitted = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig(events),
    streamForToolCall(call),
  ));

  assert.equal(tool.ran, false);
  const rejected = emitted.find((event) => event.type === "tool_rejected");
  assert.equal(rejected?.type, "tool_rejected");
  if (rejected?.type !== "tool_rejected") return;
  assert.equal(rejected.reason, "blocked");
  assert.match(rejected.result.content, /denied by policy/);
});

// ── agent/tool-result ──

test("agent/tool-result transformed result is identical in tool message and next request", async () => {
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

  const emitted = await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: history, tools },
    makeConfig(events),
    stream,
  ));

  const toolEnd = emitted.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.deepEqual(toolEnd.result, { content: "patched", isError: true });
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "patched",
    isError: true,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

// ── agent/stop ──

test("agent/stop continueWith is appended before the next turn", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stop", () => {
    stops += 1;
    return stops === 1
      ? { continueWith: { role: "user", content: "continue" } }
      : undefined;
  });
  const history: AgentMessage[] = [];
  let streams = 0;

  await collect(runAgentLoop(
    "start",
    { systemPrompt: "", messages: history, tools: new AgentToolRegistry() },
    makeConfig(events),
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

// ── shared signal ──

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

  await collect(runAgentLoop(
    "run",
    { systemPrompt: "", messages: [], tools },
    makeConfig(events),
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
