import assert from "node:assert/strict";
import test from "node:test";

import { AgentHarness } from "../../src/core/harness/agent-harness.js";
import { Session } from "../../src/core/harness/session/session.js";
import { AgentToolRegistry } from "../../src/core/agent/tools/registry.js";
import { AgentTool } from "../../src/core/agent/tools/types.js";
import { Events } from "../../src/core/events/events.js";
import type {
  AssistantMessage,
  ModelConfig,
  ModelRuntime,
} from "../../src/core/ai/types.js";
import { runtimeFromStream, type TestStream } from "../fixtures/model-runtime.js";
import { Type } from "typebox";

const modelA: ModelConfig = { provider: "test", model: "model-a" };
const modelB: ModelConfig = { provider: "test", model: "model-b" };
const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

const stream: TestStream = async function* () {
  yield { type: "text_delta", text: "done" };
  yield { type: "done", message: assistant };
};

function memorySession(): Session {
  return Session.inMemory({ cwd: process.cwd() });
}

function makeHarness(options: {
  session?: Session;
  stream?: TestStream;
  runtime?: ModelRuntime;
  systemPrompt?: string;
  events?: Events;
} = {}): { harness: AgentHarness; events: Events } {
  const events = options.events ?? new Events();
  const harness = new AgentHarness({
    session: options.session ?? memorySession(),
    runtime: options.runtime ?? runtimeFromStream(options.stream ?? stream),
    modelConfig: modelA,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: options.systemPrompt ?? "system",
    events,
  });
  return { harness, events };
}

test("sessionId exposes the bound Session identity", () => {
  const session = memorySession();
  const { harness } = makeHarness({ session });

  assert.equal(harness.sessionId, session.id);
});

test("the first persisted user prompt generates one title before the main model run", async () => {
  const session = memorySession();
  const events = new Events();
  const calls: string[] = [];
  let titleContext: Parameters<ModelRuntime["complete"]>[1] | undefined;
  let titleOptions: Parameters<ModelRuntime["complete"]>[2] | undefined;
  let completeCalls = 0;
  const runtime: ModelRuntime = {
    async complete(_model, context, options) {
      calls.push("title");
      completeCalls++;
      titleContext = context;
      titleOptions = options;
      assert.deepEqual(session.messages(), [
        { role: "user", content: "effective prompt" },
      ]);
      return {
        ...assistant,
        content: [{ type: "text", text: '  "Generated title"  \nignored' }],
      };
    },
    async *stream() {
      calls.push("run");
      yield { type: "done", message: assistant };
    },
  };
  events.on("agent/user-prompt", (input, proceed) => proceed({
    ...input,
    prompt: "effective prompt",
  }));
  events.on("agent/turn-start", () => {
    calls.push("turn-start");
  });
  const { harness } = makeHarness({ session, events, runtime });

  await harness.prompt("raw prompt");
  await harness.prompt("second prompt");

  assert.deepEqual(calls, [
    "title",
    "turn-start",
    "run",
    "turn-start",
    "run",
  ]);
  assert.equal(completeCalls, 1);
  assert.equal(harness.title, "Generated title");
  assert.equal(titleContext?.systemPrompt?.length === 0, false);
  assert.deepEqual(titleContext?.messages, [
    { role: "user", content: "effective prompt" },
  ]);
  assert.equal(titleContext?.tools, undefined);
  assert.equal(titleOptions?.maxTokens, 64);
});

test("title generation failure keeps the default title and does not stop the run", async () => {
  let completeCalls = 0;
  let streamCalls = 0;
  const runtime: ModelRuntime = {
    async complete() {
      completeCalls++;
      throw new Error("title generation failed");
    },
    async *stream() {
      streamCalls++;
      yield { type: "done", message: assistant };
    },
  };
  const { harness } = makeHarness({ runtime });

  await harness.prompt("hello");

  assert.equal(completeCalls, 1);
  assert.equal(streamCalls, 1);
  assert.equal(harness.title, "unknown");
  assert.deepEqual(harness.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

// ── Step 1: Basic prompt / event facts ──

test("prompt publishes run facts through the shared Events", async () => {
  const { harness, events } = makeHarness();
  const facts: string[] = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId === harness.sessionId) facts.push("run_start");
  });
  events.on("agent/turn-start", (input) => {
    if (input.sessionId === harness.sessionId) facts.push("turn_start");
  });
  events.on("agent/text-delta", (input) => {
    if (input.sessionId === harness.sessionId) facts.push("text_delta");
  });
  events.on("agent/turn-end", (input) => {
    if (input.sessionId === harness.sessionId) facts.push("turn_end");
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) facts.push(`run_end:${input.reason}`);
  });

  await harness.prompt("hello");

  assert.deepEqual(facts, [
    "run_start",
    "turn_start",
    "text_delta",
    "turn_end",
    "run_end:completed",
  ]);
  assert.equal(harness.isRunning, false);
  assert.deepEqual(harness.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

test("messages are in Session before terminal facts are observed", async () => {
  const session = memorySession();
  const { harness, events } = makeHarness({ session });
  events.on("agent/turn-start", (input) => {
    if (input.sessionId === harness.sessionId) {
      assert.deepEqual(
        session.messages().map((message) => message.role),
        ["user"],
      );
    }
  });
  events.on("agent/turn-end", (input) => {
    if (input.sessionId === harness.sessionId) {
      assert.deepEqual(
        session.messages().map((message) => message.role),
        ["user", "assistant"],
      );
    }
  });
  await harness.prompt("hello");
});

// ── Step 2: Subscription ordering, failure, unsubscribe ──

test("fact listeners are awaited in registration order", async () => {
  const { harness, events } = makeHarness();
  const calls: string[] = [];
  events.on("agent/turn-start", async (input) => {
    if (input.sessionId !== harness.sessionId) return;
    await Promise.resolve();
    calls.push("first");
  });
  events.on("agent/turn-start", (input) => {
    if (input.sessionId === harness.sessionId) calls.push("second");
  });

  await harness.prompt("hello");
  assert.deepEqual(calls, ["first", "second"]);
});

test("emit listener failure is isolated and does not reject prompt", async () => {
  const { harness, events } = makeHarness();
  const calls: string[] = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    calls.push("first");
    throw new Error("listener failed");
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) calls.push("second");
  });

  await harness.prompt("hello");
  assert.equal(harness.isRunning, false);
  assert.deepEqual(calls, ["first", "second"]);
});

test("abort from run-start prevents the Agent execution", async () => {
  let streamCalls = 0;
  const { harness, events } = makeHarness({
    stream: async function* () {
      streamCalls++;
      yield { type: "done", message: assistant };
    },
  });
  const facts: string[] = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    facts.push("run_start");
    harness.abort();
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) facts.push(`run_end:${input.reason}`);
  });

  await harness.prompt("hello");

  assert.equal(streamCalls, 0);
  assert.deepEqual(facts, ["run_start", "run_end:aborted"]);
  assert.deepEqual(harness.messages, []);
});

test("persistence failure still publishes one run_end error", async () => {
  const session = memorySession();
  session.append = async () => {
    throw new Error("storage failed");
  };
  const { harness, events } = makeHarness({ session });
  const facts: string[] = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId === harness.sessionId) facts.push("run_start");
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) facts.push(`run_end:${input.reason}`);
  });

  await assert.rejects(harness.prompt("hello"), /storage failed/);

  assert.deepEqual(facts, ["run_start", "run_end:error"]);
  assert.equal(harness.isRunning, false);
});

test("abort concurrent with storage failure still rejects the Run", async () => {
  const session = memorySession();
  let aborted = false;
  session.append = async () => {
    if (!aborted) {
      aborted = true;
      harness.abort();
    }
    throw new Error("storage failed");
  };
  const { harness, events } = makeHarness({ session });
  const facts: Array<{ type: string; reason?: string; errorMessage?: string }> = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId === harness.sessionId) facts.push({ type: "run_start" });
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    facts.push(input.reason === "error"
      ? { type: "run_end", reason: input.reason, errorMessage: input.errorMessage }
      : { type: "run_end", reason: input.reason });
  });

  await assert.rejects(harness.prompt("hello"), /storage failed/);

  assert.equal(harness.isRunning, false);
  assert.deepEqual(facts, [
    { type: "run_start" },
    { type: "run_end", reason: "error", errorMessage: "storage failed" },
  ]);
});

test("run identity is stable within a run and differs across runs", async () => {
  const session = memorySession();
  const { harness, events } = makeHarness({ session });
  const runIds: string[] = [];
  const endRunIds: string[] = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId === harness.sessionId) runIds.push(input.runId);
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) endRunIds.push(input.runId);
  });

  await harness.prompt("hello");
  const firstRun = runIds[0];
  assert.equal(firstRun, endRunIds[0]);

  await harness.prompt("hello");
  assert.equal(runIds.length, 2);
  assert.notEqual(firstRun, runIds[1]);
});

// ── Step 3: Active-run, abort, model, tool, system prompt ──

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("restores Session model and persists later switches", async () => {
  const session = memorySession();
  await session.append({ type: "model_selection", selection: modelB });
  const { harness } = makeHarness({ session });
  assert.deepEqual(harness.model, modelB);

  await harness.switchModel(modelA);
  assert.deepEqual(harness.model, modelA);
  assert.deepEqual(session.modelSelection(), modelA);
});

test("failed model persistence leaves current model unchanged", async () => {
  const session = memorySession();
  const { harness } = makeHarness({ session });
  session.append = async () => {
    throw new Error("storage failed");
  };

  await assert.rejects(harness.switchModel(modelB), /storage failed/);
  assert.deepEqual(harness.model, modelA);
});

test("system prompt and tool changes reach the Agent run", async () => {
  let seenTools: string[] = [];
  let seenPrompt = "";
  const registry = new AgentToolRegistry();
  const tool = new (class extends AgentTool {
    constructor() {
      super("dynamic", "dynamic", Type.Object({}));
    }
    async execute() {
      return { content: "ok", isError: false };
    }
  })();
  const harness = new AgentHarness({
    session: memorySession(),
    runtime: runtimeFromStream(async function* (_model, context) {
      seenTools = context.tools?.map((entry) => entry.name) ?? [];
      seenPrompt = context.systemPrompt ?? "";
      yield { type: "done", message: assistant };
    }),
    modelConfig: modelA,
    toolRegistry: registry,
    systemPrompt: "system",
    events: new Events(),
  });

  harness.registerTool(tool);
  await harness.prompt("first");
  assert.deepEqual(seenTools, ["dynamic"]);
  assert.equal(seenPrompt, "system");

  harness.unregisterTool("dynamic");
  await harness.prompt("second");
  assert.deepEqual(seenTools, []);
  assert.equal(seenPrompt, "system");
});

test("abort during Agent streaming settles the Harness run", async () => {
  const started = deferred();
  const abortedAssistant: AssistantMessage = {
    ...assistant,
    content: [],
    stopReason: "aborted",
    errorMessage: "aborted",
  };
  const { harness, events } = makeHarness({
    stream: async function* (_model, _context, options) {
      const signal = options?.signal;
      assert.ok(signal);
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", message: abortedAssistant };
    },
  });
  const facts: string[] = [];
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) facts.push(input.reason);
  });

  const run = harness.prompt("hello");
  await started.promise;
  harness.abort();
  await run;

  assert.equal(harness.isRunning, false);
  assert.deepEqual(facts, ["aborted"]);
  const lastMessage = harness.messages.at(-1);
  assert.equal(
    lastMessage?.role === "assistant"
      ? lastMessage.stopReason
      : undefined,
    "aborted",
  );
});

// ── Task 5: run boundaries ──

test("exactly one run-end follows every observed run-start", async () => {
  const boundaryHarness = (options: {
    session?: Session;
    stream?: TestStream;
  } = {}) => {
    const { harness, events } = makeHarness(options);
    const boundaries: string[] = [];
    events.on("harness/run-start", (input) => {
      if (input.sessionId === harness.sessionId) boundaries.push("run_start");
    });
    events.on("harness/run-end", (input) => {
      if (input.sessionId === harness.sessionId) boundaries.push(`run_end:${input.reason}`);
    });
    return { harness, boundaries };
  };

  {
    const { harness, boundaries } = boundaryHarness();
    await harness.prompt("hello");
    assert.equal(boundaries.filter((entry) => entry === "run_start").length, 1, "completed");
    assert.equal(boundaries.filter((entry) => entry.startsWith("run_end:")).length, 1, "completed");
  }

  {
    const started = deferred();
    const release = deferred();
    const { harness, boundaries } = boundaryHarness({
      stream: async function* () {
        started.resolve();
        await release.promise;
        yield { type: "done", message: assistant };
      },
    });
    const run = harness.prompt("hello");
    await started.promise;
    harness.abort();
    release.resolve();
    await run;
    assert.equal(boundaries.filter((entry) => entry === "run_start").length, 1, "aborted");
    assert.equal(boundaries.filter((entry) => entry.startsWith("run_end:")).length, 1, "aborted");
  }

  {
    const session = memorySession();
    session.append = async () => { throw new Error("storage failed"); };
    const { harness, boundaries } = boundaryHarness({ session });
    await assert.rejects(harness.prompt("hello"), /storage failed/);
    assert.equal(boundaries.filter((entry) => entry === "run_start").length, 1, "error");
    assert.equal(boundaries.filter((entry) => entry.startsWith("run_end:")).length, 1, "error");
  }
});

// ── Task 4: Harness control-event pass-through tests ──

test("Harness shares one Events instance with Agent Loop", async () => {
  const events = new Events();
  const calls: string[] = [];
  events.on("agent/user-prompt", (input, proceed) => {
    calls.push("user_prompt");
    return proceed(input);
  });
  events.on("agent/context", (input, proceed) => {
    calls.push("context");
    return proceed(input);
  });
  const { harness } = makeHarness({ events });
  await harness.prompt("hello");
  assert.deepEqual(calls, [
    "user_prompt", "context",
  ]);
});

test("agent/user-prompt and agent/context interceptor failures reject prompt and restore idle", async () => {
  for (const type of ["agent/user-prompt", "agent/context"] as const) {
    const events = new Events();
    if (type === "agent/user-prompt") {
      events.on("agent/user-prompt", () => { throw new Error("user_prompt failed"); });
    } else {
      events.on("agent/context", () => { throw new Error("context failed"); });
    }
    const { harness } = makeHarness({ events });

    const label = type === "agent/user-prompt" ? "user_prompt" : "context";
    await assert.rejects(harness.prompt("hello"), new RegExp(`${label} failed`));
    assert.equal(harness.isRunning, false);
  }
});

// ── Task 4: tool result ordering against persisted Session ──

test("tool-result subscriber sees the persisted result message", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new (class extends AgentTool {
    constructor() {
      super("echo", "Echo", Type.Object({}));
    }
    async execute() {
      return { content: "ok", details: { count: 1 }, isError: false };
    }
  })());
  const session = memorySession();
  const tc = { type: "toolCall" as const, id: "c1", name: "echo", arguments: {} };
  const toolTurn: AssistantMessage = {
    role: "assistant",
    content: [tc],
    model: "model-a",
    stopReason: "toolUse",
    latencyMs: 0,
  };
  let turn = 0;
  const stream: TestStream = async function* () {
    turn += 1;
    if (turn === 1) {
      yield { type: "toolcall_start", id: "c1", name: "echo" };
      yield { type: "toolcall_end", toolCall: tc };
      yield { type: "done", message: toolTurn };
    } else {
      yield { type: "done", message: assistant };
    }
  };
  const events = new Events();
  const harness = new AgentHarness({
    session,
    runtime: runtimeFromStream(stream),
    modelConfig: modelA,
    toolRegistry: registry,
    systemPrompt: "system",
    events,
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    const message = session.messages().find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined && message.role === "tool" &&
      message.content === input.result.content &&
      JSON.stringify(message.details) === JSON.stringify(input.result.details);
    observed.push({ type: "tool-result", matches });
  });

  await harness.prompt("run");
  assert.deepEqual(observed, [{ type: "tool-result", matches: true }]);
});

test("tool-result subscriber sees the persisted synthetic message for an unknown call", async () => {
  const registry = new AgentToolRegistry();
  const session = memorySession();
  const tc = { type: "toolCall" as const, id: "c1", name: "missing", arguments: {} };
  const toolTurn: AssistantMessage = {
    role: "assistant",
    content: [tc],
    model: "model-a",
    stopReason: "toolUse",
    latencyMs: 0,
  };
  let turn = 0;
  const stream: TestStream = async function* () {
    turn += 1;
    if (turn === 1) {
      yield { type: "toolcall_start", id: "c1", name: "missing" };
      yield { type: "toolcall_end", toolCall: tc };
      yield { type: "done", message: toolTurn };
    } else {
      yield { type: "done", message: assistant };
    }
  };
  const events = new Events();
  const harness = new AgentHarness({
    session,
    runtime: runtimeFromStream(stream),
    modelConfig: modelA,
    toolRegistry: registry,
    systemPrompt: "system",
    events,
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  events.on("agent/tool-result", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    const message = session.messages().find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined &&
      message.content === input.result.content;
    observed.push({ type: "tool-result", matches });
  });

  await harness.prompt("run");
  assert.deepEqual(observed, [{ type: "tool-result", matches: true }]);
});
