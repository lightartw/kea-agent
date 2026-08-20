import assert from "node:assert/strict";
import test from "node:test";

import { AgentHarness } from "../../src/core/harness/agent-harness.js";
import { Session } from "../../src/core/harness/session/session.js";
import { AgentToolRegistry } from "../../src/core/harness/tools/registry.js";
import { AgentTool } from "../../src/core/harness/tools/types.js";
import type {
  AssistantMessage,
  ModelConfig,
  ModelRuntime,
} from "../../src/core/ai/types.js";
import type {
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  HarnessEvent,
} from "../../src/core/harness/index.js";
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
  onListenerError?: (error: unknown, type: string, event: unknown) => void;
} = {}): AgentHarness {
  return new AgentHarness({
    session: options.session ?? memorySession(),
    runtime: options.runtime ?? runtimeFromStream(options.stream ?? stream),
    modelConfig: modelA,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: options.systemPrompt ?? "system",
    ...(options.onListenerError === undefined
      ? {}
      : { onListenerError: options.onListenerError as never }),
  });
}

test("sessionId exposes the bound Session identity", () => {
  const session = memorySession();
  const harness = makeHarness({ session });

  assert.equal(harness.sessionId, session.id);
});

test("the first persisted user prompt generates one title before the main model run", async () => {
  const session = memorySession();
  const harness = makeHarness({ session });
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
  const h = new AgentHarness({
    session,
    runtime,
    modelConfig: modelA,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: "system",
  });
  h.hooks.on("beforePrompt", ({ prompt }) => ({ prompt: "effective prompt" }));
  h.subscribe((event) => {
    if (event.type === "turn-start") calls.push("turn-start");
  });

  await h.prompt("raw prompt");
  await h.prompt("second prompt");

  assert.deepEqual(calls, [
    "title",
    "turn-start",
    "run",
    "turn-start",
    "run",
  ]);
  assert.equal(completeCalls, 1);
  assert.equal(h.title, "Generated title");
  assert.equal(titleContext?.systemPrompt?.length === 0, false);
  assert.deepEqual(titleContext?.messages, [
    { role: "user", content: "effective prompt" },
  ]);
  assert.equal(titleContext?.tools, undefined);
  assert.equal(titleOptions?.maxTokens, 1024);
});

test("title generation failure falls back to the prompt text", async () => {
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
  const harness = makeHarness({ runtime });

  await harness.prompt("hello");

  assert.equal(completeCalls, 1);
  assert.equal(streamCalls, 1);
  assert.equal(harness.title, "hello");
  assert.deepEqual(harness.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

// ── Step 1: Basic prompt / event facts ──

test("prompt publishes run facts through the Harness event bus", async () => {
  const harness = makeHarness();
  const facts: string[] = [];
  harness.subscribe((event) => {
    switch (event.type) {
      case "run-start": facts.push("run_start"); break;
      case "turn-start": facts.push("turn_start"); break;
      case "text-delta": facts.push("text_delta"); break;
      case "turn-end": facts.push("turn_end"); break;
      case "run-end": facts.push(`run_end:${event.reason}`); break;
      default: break;
    }
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
  const harness = makeHarness({ session });
  harness.subscribe((event) => {
    if (event.type === "turn-start") {
      assert.deepEqual(
        session.messages().map((message) => message.role),
        ["user"],
      );
    }
    if (event.type === "turn-end") {
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
  const harness = makeHarness();
  const calls: string[] = [];
  harness.subscribe(async (event) => {
    if (event.type !== "turn-start") return;
    await Promise.resolve();
    calls.push("first");
  });
  harness.subscribe((event) => {
    if (event.type === "turn-start") calls.push("second");
  });

  await harness.prompt("hello");
  assert.deepEqual(calls, ["first", "second"]);
});

test("emit listener failure is isolated and does not reject prompt", async () => {
  const reported: string[] = [];
  const harness = makeHarness({ onListenerError: (error) => reported.push(String(error)) });
  const calls: string[] = [];
  harness.subscribe((event) => {
    if (event.type === "run-start") {
      calls.push("first");
      throw new Error("listener failed");
    }
    if (event.type === "run-end") calls.push("second");
  });

  await harness.prompt("hello");
  assert.equal(harness.isRunning, false);
  assert.deepEqual(calls, ["first", "second"]);
  assert.ok(reported.some((entry) => entry.includes("listener failed")));
});

test("abort from run-start prevents the Agent execution", async () => {
  let streamCalls = 0;
  const harness = makeHarness({
    stream: async function* () {
      streamCalls++;
      yield { type: "done", message: assistant };
    },
  });
  const facts: string[] = [];
  harness.subscribe((event) => {
    if (event.type === "run-start") {
      facts.push("run_start");
      harness.abort();
    }
    if (event.type === "run-end") facts.push(`run_end:${event.reason}`);
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
  const harness = makeHarness({ session });
  const facts: string[] = [];
  harness.subscribe((event) => {
    if (event.type === "run-start") facts.push("run_start");
    if (event.type === "run-end") facts.push(`run_end:${event.reason}`);
  });

  await assert.rejects(harness.prompt("hello"), /storage failed/);

  assert.deepEqual(facts, ["run_start", "run_end:error"]);
  assert.equal(harness.isRunning, false);
});

test("run identity is stable within a run and differs across runs", async () => {
  const session = memorySession();
  const harness = makeHarness({ session });
  const runIds: string[] = [];
  const endRunIds: string[] = [];
  harness.subscribe((event) => {
    if (event.type === "run-start") runIds.push(event.runId);
    if (event.type === "run-end") endRunIds.push(event.runId);
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
  const harness = makeHarness({ session });
  assert.deepEqual(harness.model, modelB);

  await harness.switchModel(modelA);
  assert.deepEqual(harness.model, modelA);
  assert.deepEqual(session.modelSelection(), modelA);
});

test("failed model persistence leaves current model unchanged", async () => {
  const session = memorySession();
  const harness = makeHarness({ session });
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
  const harness = makeHarness({
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
  harness.subscribe((event) => {
    if (event.type === "run-end") facts.push(event.reason);
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

// ── run boundaries ──

test("exactly one run-end follows every observed run-start", async () => {
  const boundaryHarness = (options: {
    session?: Session;
    stream?: TestStream;
  } = {}) => {
    const harness = makeHarness(options);
    const boundaries: string[] = [];
    harness.subscribe((event) => {
      if (event.type === "run-start") boundaries.push("run_start");
      if (event.type === "run-end") boundaries.push(`run_end:${event.reason}`);
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

// ── Control hooks ──

test("Harness control hooks are called during a Run", async () => {
  const harness = makeHarness();
  const calls: string[] = [];
  harness.hooks.on("beforePrompt", ({ prompt }) => { calls.push("user_prompt"); return { prompt }; });
  harness.hooks.on("transformContext", ({ messages }) => { calls.push("context"); return { messages }; });

  await harness.prompt("hello");

  assert.deepEqual(calls, ["user_prompt", "context"]);
});

test("beforePrompt and transformContext hook failures reject prompt and restore idle", async () => {
  for (const name of ["beforePrompt", "transformContext"] as const) {
    const harness = makeHarness();
    if (name === "beforePrompt") {
      harness.hooks.on("beforePrompt", () => { throw new Error("user_prompt failed"); });
    } else {
      harness.hooks.on("transformContext", () => { throw new Error("context failed"); });
    }

    const label = name === "beforePrompt" ? "user_prompt" : "context";
    await assert.rejects(harness.prompt("hello"), new RegExp(`${label} failed`));
    assert.equal(harness.isRunning, false);
  }
});

// ── tool result ordering against persisted Session ──

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
  const harness = new AgentHarness({
    session,
    runtime: runtimeFromStream(stream),
    modelConfig: modelA,
    toolRegistry: registry,
    systemPrompt: "system",
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  harness.subscribe((event) => {
    if (event.type !== "tool-result") return;
    const message = session.messages().find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined && message.role === "tool" &&
      message.content === event.result.content &&
      JSON.stringify(message.details) === JSON.stringify(event.result.details);
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
  const harness = new AgentHarness({
    session,
    runtime: runtimeFromStream(stream),
    modelConfig: modelA,
    toolRegistry: registry,
    systemPrompt: "system",
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  harness.subscribe((event) => {
    if (event.type !== "tool-result") return;
    const message = session.messages().find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined &&
      message.content === event.result.content;
    observed.push({ type: "tool-result", matches });
  });

  await harness.prompt("run");
  assert.deepEqual(observed, [{ type: "tool-result", matches: true }]);
});

// ── Session-scoped Harness subscription ──

test("subscribe listener failure is isolated and does not reject prompt", async () => {
  const reported: string[] = [];
  const harness = makeHarness({ onListenerError: (error, type) => reported.push(String(type)) });
  harness.subscribe(() => {
    throw new Error("subscriber failed");
  });

  await harness.prompt("hello");

  assert.equal(harness.isRunning, false);
  assert.deepEqual(reported, [
    "run-start",
    "turn-start",
    "text-delta",
    "turn-end",
    "run-end",
  ]);
});

test("subscribe delivers the full fact stream and unsubscribe is idempotent", async () => {
  const harness = makeHarness();
  const facts: HarnessEvent[] = [];
  const unsubscribe = harness.subscribe((event) => facts.push(event));

  await harness.prompt("hello");
  unsubscribe();
  unsubscribe();

  assert.deepEqual(facts.map((event) => event.type), [
    "run-start",
    "turn-start",
    "text-delta",
    "turn-end",
    "run-end",
  ]);
  for (const fact of facts) {
    assert.equal(Object.hasOwn(fact, "sessionId"), false);
  }
});

test("maxTurns limits the Agent loop to one turn", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new (class extends AgentTool {
    constructor() {
      super("echo", "Echo", Type.Object({}));
    }
    async execute() {
      return { content: "ok", isError: false };
    }
  })());
  const tc = { type: "toolCall" as const, id: "c1", name: "echo", arguments: {} };
  const toolTurn: AssistantMessage = {
    role: "assistant",
    content: [tc],
    model: "model-a",
    stopReason: "toolUse",
    latencyMs: 0,
  };
  let streamCalls = 0;
  const harness = new AgentHarness({
    session: memorySession(),
    runtime: runtimeFromStream(async function* () {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield { type: "toolcall_start", id: "c1", name: "echo" };
        yield { type: "toolcall_end", toolCall: tc };
        yield { type: "done", message: toolTurn };
      } else {
        yield { type: "done", message: assistant };
      }
    }),
    modelConfig: modelA,
    toolRegistry: registry,
    systemPrompt: "system",
    maxTurns: 1,
  });
  let turnEnds = 0;
  harness.subscribe((event) => {
    if (event.type === "turn-end") turnEnds += 1;
  });

  await harness.prompt("run");

  assert.equal(streamCalls, 1);
  assert.equal(turnEnds, 1);
});
