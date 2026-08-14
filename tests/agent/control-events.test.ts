import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { runAgentLoop } from "../../src/agent/agent-loop.js";
import type {
  AgentContext,
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

function memoryContext(
  tools = new AgentToolRegistry(),
  history: AgentMessage[] = [],
): AgentContext {
  return {
    systemPrompt: "",
    messages: history,
    tools,
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

test("agent/user-prompt blocking prevents message insertion and model calls", async () => {
  const events = new Events();
  events.on("agent/user-prompt", () => undefined);
  let streams = 0;
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history);
  const recorded: string[] = [];
  events.on("agent/turn-start", (input) => {
    if (input.sessionId === "session-1") recorded.push("turn-start");
  });

  await runAgentLoop(
    "secret",
    context,
    makeConfig(events),
    async function* () {
      streams++;
      yield { type: "done", message: assistantMsg("unused") };
    },
  );

  assert.equal(streams, 0);
  assert.deepEqual(history, []);
  assert.deepEqual(recorded, []);
});

test("agent/user-prompt a returned prompt runs the Run", async () => {
  const events = new Events();
  events.on("agent/user-prompt", (input, proceed) => proceed(input));
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history);

  await runAgentLoop(
    "hello",
    context,
    makeConfig(events),
    async function* () {
      yield { type: "done", message: assistantMsg("done") };
    },
  );

  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
});

// ── agent/context ──

test("agent/context intercept reaches the model without replacing history", async () => {
  const events = new Events();
  events.on("agent/context", (input, proceed) => proceed({
    ...input,
    messages: [
      ...input.messages,
      { role: "user", content: "request-only" },
    ],
  }));
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history);
  let requestMessages: readonly Message[] = [];

  await runAgentLoop(
    "real",
    context,
    makeConfig(events),
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

// ── Tool interception and facts ──

test("tools/pre-execute can replace arguments before validation", async () => {
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
  events.on("tools/pre-execute", (input, proceed) => proceed({
    ...input,
    arguments: { value: "fixed" },
  }));

  await runAgentLoop("run", memoryContext(tools), makeConfig(events), streamForToolCall(call));
  assert.equal(tool.ran, true);
  assert.equal(tool.seen, "fixed");
});

test("tools/pre-execute can block execution", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context = memoryContext(tools, history);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("tools/pre-execute", () => ({
    content: "Error: denied by policy",
    isError: true,
  }));
  const results: AgentToolResult[] = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId === "session-1") results.push(input.result);
  });

  await runAgentLoop("run", context, makeConfig(events), streamForToolCall(call));

  assert.equal(tool.ran, false);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { content: "Error: denied by policy", isError: true });
});

test("tools/post-execute transformed result is identical in tool message and next request", async () => {
  const tool = new NoopTool();
  const tools = new AgentToolRegistry();
  tools.register(tool);
  const history: AgentMessage[] = [];
  const context = memoryContext(tools, history);
  const call: AgentToolCall = {
    type: "toolCall", id: "c1", name: "noop", arguments: {},
  };
  const events = new Events();
  events.on("tools/post-execute", (input, proceed) => proceed({
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
  const results: AgentToolResult[] = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId === "session-1") results.push(input.result);
  });

  await runAgentLoop("run", context, makeConfig(events), stream);

  assert.deepEqual(results[0], { content: "patched", isError: true });
  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "patched",
    isError: true,
  });
  assert.deepEqual(secondRequest.at(-1), history[2]);
});

// ── agent/stopping ──

test("agent/stopping continues when it returns a message", async () => {
  const events = new Events();
  let stops = 0;
  events.on("agent/stopping", () => {
    stops += 1;
    return stops === 1
      ? { role: "user", content: "continue" }
      : undefined;
  });
  const history: AgentMessage[] = [];
  const context = memoryContext(undefined, history);
  let streams = 0;

  await runAgentLoop(
    "start",
    context,
    makeConfig(events),
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

// ── shared signal ──

test("the same AbortSignal reaches every control listener", async () => {
  const events = new Events();
  const seen: Array<{ type: string; signal: AbortSignal | undefined }> = [];
  events.on("agent/user-prompt", (input, proceed, signal) => {
    seen.push({ type: "user_prompt", signal });
    return proceed(input);
  });
  events.on("agent/context", (input, proceed, signal) => {
    seen.push({ type: "context", signal });
    return proceed(input);
  });
  events.on("agent/stopping", (_input, _proceed, signal) => {
    seen.push({ type: "stopping", signal });
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
    memoryContext(tools),
    makeConfig(events),
    streamForToolCall(call),
    controller.signal,
  );

  assert.deepEqual(seen.map(({ type }) => type), [
    "user_prompt",
    "context",
    "context",
    "stopping",
  ]);
  assert.ok(seen.every(({ signal }) => signal === controller.signal));
});
