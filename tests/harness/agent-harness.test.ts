import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentHarness } from "../../src/harness/agent-harness.js";
import { Session } from "../../src/harness/session/session.js";
import type { CreateSessionInput } from "../../src/harness/session/types.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
import { AgentTool } from "../../src/agent/tools/types.js";
import { Events } from "../../src/events/events.js";
import type { HarnessConfig, SessionTitleGenerator } from "../../src/harness/types.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";
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

const stream: StreamFn = async function* () {
  yield { type: "text_delta", text: "done" };
  yield { type: "done", message: assistant };
};

function sessionInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    projectId: "project_test",
    directory: process.cwd(),
    cwd: ".",
    ...overrides,
  };
}

function memorySession(): Session {
  return Session.inMemory(sessionInput());
}

function makeHarness(options: {
  session?: Session;
  streamFn?: StreamFn;
  systemPrompt?: () => string | Promise<string>;
  events?: Events;
  titleGenerator?: SessionTitleGenerator;
} = {}): { harness: AgentHarness; events: Events } {
  const events = options.events ?? new Events();
  const harness = new AgentHarness({
    session: options.session ?? memorySession(),
    model: modelA,
    streamFn: options.streamFn ?? stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: options.systemPrompt ?? (() => "system"),
    cwd: process.cwd(),
    events,
    ...(options.titleGenerator !== undefined ? { titleGenerator: options.titleGenerator } : {}),
  });
  return { harness, events };
}

test("sessionId exposes the bound Session identity", () => {
  const session = memorySession();
  const { harness } = makeHarness({ session });

  assert.equal(harness.sessionId, session.id);
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
        session.buildContext().messages.map((message) => message.role),
        ["user"],
      );
    }
  });
  events.on("agent/turn-end", (input) => {
    if (input.sessionId === harness.sessionId) {
      assert.deepEqual(
        session.buildContext().messages.map((message) => message.role),
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
    streamFn: async function* () {
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
  session.appendMessage = async () => {
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
  session.appendMessage = async () => {
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

// ── Step 3: Active-run, abort, model, tool, prompt-builder ──

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

test("Harness is busy while an async system prompt is being built", async () => {
  const gate = deferred();
  const { harness } = makeHarness({
    systemPrompt: async () => {
      await gate.promise;
      return "system";
    },
  });

  const first = harness.prompt("first");
  assert.equal(harness.isRunning, true);
  await assert.rejects(harness.prompt("second"), /busy/);
  await assert.rejects(harness.switchModel(modelB), /busy/);
  assert.throws(() => harness.unregisterTool("missing"), /busy/);
  assert.throws(() =>
    harness.registerTool(
      new (class extends AgentTool {
        constructor() {
          super("test", "test", Type.Object({}));
        }
        async execute() {
          return { content: "ok", isError: false };
        }
      })(),
    ),
  );

  gate.resolve();
  await first;
});

test("abort during prompt preparation prevents the Agent run", async () => {
  const gate = deferred();
  let streamCalls = 0;
  const { harness } = makeHarness({
    systemPrompt: async () => {
      await gate.promise;
      return "system";
    },
    streamFn: async function* () {
      streamCalls++;
      yield { type: "done", message: assistant };
    },
  });

  const run = harness.prompt("hello");
  harness.abort();
  gate.resolve();
  await run;

  assert.equal(streamCalls, 0);
  assert.equal(harness.isRunning, false);
});

test("restores Session model and persists later switches", async () => {
  const session = memorySession();
  await session.appendModelChange(modelB);
  const { harness } = makeHarness({ session });
  assert.deepEqual(harness.model, modelB);

  await harness.switchModel(modelA);
  assert.deepEqual(harness.model, modelA);
  assert.deepEqual(session.buildContext().model, modelA);
});

test("failed model persistence leaves current model unchanged", async () => {
  const session = memorySession();
  const { harness } = makeHarness({ session });
  session.appendModelChange = async () => {
    throw new Error("storage failed");
  };

  await assert.rejects(harness.switchModel(modelB), /storage failed/);
  assert.deepEqual(harness.model, modelA);
});

test("tool changes and async prompt builder affect the next run", async () => {
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
    model: modelA,
    streamFn: async function* (_model, context) {
      seenTools = context.tools?.map((entry) => entry.name) ?? [];
      seenPrompt = context.systemPrompt ?? "";
      yield { type: "done", message: assistant };
    },
    toolRegistry: registry,
    systemPrompt: async ({ tools }) =>
      `tools=${tools.map((entry) => entry.name).join(",")}`,
    cwd: process.cwd(),
    events: new Events(),
  });

  harness.registerTool(tool);
  await harness.prompt("first");
  assert.deepEqual(seenTools, ["dynamic"]);
  assert.equal(seenPrompt, "tools=dynamic");

  harness.unregisterTool("dynamic");
  await harness.prompt("second");
  assert.deepEqual(seenTools, []);
  assert.equal(seenPrompt, "tools=");
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
    streamFn: async function* (_model, _context, options) {
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
    streamFn?: StreamFn;
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
      streamFn: async function* () {
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
    session.appendMessage = async () => { throw new Error("storage failed"); };
    const { harness, boundaries } = boundaryHarness({ session });
    await assert.rejects(harness.prompt("hello"), /storage failed/);
    assert.equal(boundaries.filter((entry) => entry === "run_start").length, 1, "error");
    assert.equal(boundaries.filter((entry) => entry.startsWith("run_end:")).length, 1, "error");
  }
});

test("an AbortSignal fired while Permission awaits confirmation wins over the answer", async () => {
  const { harness, events } = makeHarness({
    streamFn: streamFnWithToolCall(),
  });
  const signal: AbortSignal[] = [];
  let resolvePermission: (value: boolean) => void = () => undefined;
  const permissionGate = new Promise<boolean>((resolve) => { resolvePermission = resolve; });
  events.on("agent/tool-call", (decision, next, abortSignal) => {
    signal.push(abortSignal!);
    return permissionGate.then((allowed) => {
      if (allowed) return next(decision);
      return {
        ...decision,
        kind: "reject" as const,
        call: decision.call,
        reason: "permission denied by user",
      };
    });
  });
  const reasons: string[] = [];
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId === harness.sessionId) reasons.push(input.reason);
  });

  const run = harness.prompt("run tool");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  harness.abort();
  resolvePermission(false);
  await run;

  assert.equal(signal.length, 1);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0], "aborted");
});

function streamFnWithToolCall(): StreamFn {
  const tc = { type: "toolCall" as const, id: "c1", name: "echo", arguments: {} };
  const toolTurn: AssistantMessage = {
    role: "assistant",
    content: [tc],
    model: "model-a",
    stopReason: "toolUse",
    latencyMs: 0,
  };
  let turn = 0;
  return async function* () {
    turn += 1;
    if (turn === 1) {
      yield { type: "toolcall_start", id: "c1", name: "echo" };
      yield { type: "toolcall_end", toolCall: tc };
      yield { type: "done", message: toolTurn };
    } else {
      yield { type: "done", message: assistant };
    }
  };
}

// ── Task 4: Harness control-event pass-through tests ──

test("Harness shares one Events instance with Agent Loop", async () => {
  const events = new Events();
  const calls: string[] = [];
  events.on("agent/user-prompt", () => { calls.push("user_prompt"); });
  events.on("agent/context", (input, next) => {
    calls.push("context");
    return next(input);
  });
  events.on("agent/stop", () => { calls.push("stop"); });

  const { harness } = makeHarness({ events });
  await harness.prompt("hello");
  assert.deepEqual(calls, [
    "user_prompt", "context", "stop",
  ]);
});

test("agent/user-prompt and agent/context listener failures reject prompt and restore idle", async () => {
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

test("agent/stop listener failure keeps the completed assistant message and restores idle", async () => {
  const events = new Events();
  events.on("agent/stop", () => { throw new Error("stop failed"); });
  const { harness } = makeHarness({ events });

  await assert.rejects(harness.prompt("hello"), /stop failed/);
  assert.equal(harness.messages.at(-1)?.role, "assistant");
  assert.equal(harness.isRunning, false);
});

// ── Task 4: tool terminal event ordering against persisted Session ──

test("tool_end subscriber sees the persisted result message", async () => {
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
  const streamFn: StreamFn = async function* () {
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
    model: modelA,
    streamFn,
    toolRegistry: registry,
    systemPrompt: () => "system",
    cwd: process.cwd(),
    events,
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  events.on("agent/tool-end", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    const message = session.buildContext().messages.find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined && message.role === "tool" &&
      message.content === input.result.content &&
      JSON.stringify(message.details) === JSON.stringify(input.result.details);
    observed.push({ type: "tool_end", matches });
  });
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    const message = session.buildContext().messages.find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined &&
      message.content === input.result.content;
    observed.push({ type: "tool_rejected", matches });
  });

  await harness.prompt("run");
  assert.deepEqual(observed, [{ type: "tool_end", matches: true }]);
});

test("tool_rejected subscriber sees the persisted synthetic message", async () => {
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
  const streamFn: StreamFn = async function* () {
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
    model: modelA,
    streamFn,
    toolRegistry: registry,
    systemPrompt: () => "system",
    cwd: process.cwd(),
    events,
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  events.on("agent/tool-end", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    const message = session.buildContext().messages.find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined && message.role === "tool" &&
      message.content === input.result.content;
    observed.push({ type: "tool_end", matches });
  });
  events.on("agent/tool-rejected", (input) => {
    if (input.sessionId !== harness.sessionId) return;
    const message = session.buildContext().messages.find(
      (entry) => entry.role === "tool" && entry.toolCallId === "c1",
    );
    const matches = message !== undefined &&
      message.content === input.result.content;
    observed.push({ type: "tool_rejected", matches });
  });

  await harness.prompt("run");
  assert.deepEqual(observed, [{ type: "tool_rejected", matches: true }]);
});

// ── Task 4: automatic title timing ──

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      assertion();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("eventually timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("first persisted user message starts title generation beside the response", async () => {
  const titleStarted = deferred();
  const releaseTitle = deferred();
  const modelStarted = deferred();
  const session = memorySession();
  const { harness } = makeHarness({
    session,
    titleGenerator: async (prompt, titleModel) => {
      assert.equal(prompt, "design sessions");
      assert.deepEqual(titleModel, modelA);
      assert.equal(session.buildContext().messages[0]?.role, "user");
      titleStarted.resolve();
      await releaseTitle.promise;
      return "Session design";
    },
    streamFn: async function* () {
      modelStarted.resolve();
      yield { type: "done", message: assistant };
    },
  });

  const run = harness.prompt("design sessions");
  await Promise.all([titleStarted.promise, modelStarted.promise]);
  releaseTitle.resolve();
  await run;
  await eventually(() => assert.equal(harness.title, "Session design"));
});

test("blocked first prompts do not start title generation", async () => {
  const session = memorySession();
  let titleCalls = 0;
  const events = new Events();
  events.on("agent/user-prompt", () => ({ block: true, reason: "blocked" }));
  const { harness } = makeHarness({
    session,
    events,
    titleGenerator: async () => {
      titleCalls++;
      return "should not run";
    },
  });

  await harness.prompt("hello");
  assert.equal(session.buildContext().messages.filter((message) => message.role === "user").length, 0);
  assert.equal(titleCalls, 0);
  assert.equal(harness.title, "unknown");
});

test("title generator failure never rejects the run or changes run_end", async () => {
  const session = memorySession();
  const { harness, events } = makeHarness({
    session,
    titleGenerator: async () => {
      throw new Error("title model failed");
    },
  });

  const facts: string[] = [];
  events.on("harness/run-start", (input) => {
    if (input.sessionId === harness.sessionId) facts.push("run_start");
  });
  events.on("harness/run-end", (input) => {
    if (input.sessionId === harness.sessionId) facts.push(`run_end:${input.reason}`);
  });
  await harness.prompt("hello");
  assert.deepEqual(facts, ["run_start", "run_end:completed"]);
  assert.equal(harness.title, "unknown");
});

test("generator output is trimmed to one line and capped", async () => {
  const session = memorySession();
  const { harness } = makeHarness({
    session,
    titleGenerator: async () => `${"x".repeat(120)}\nignored line`,
  });

  await harness.prompt("hello");
  await eventually(() => assert.equal(harness.title, `${"x".repeat(97)}...`));
});

test("manual rename racing with generated output is never overwritten", async () => {
  const releaseTitle = deferred();
  const session = memorySession();
  const { harness } = makeHarness({
    session,
    titleGenerator: async () => {
      await releaseTitle.promise;
      return "Generated";
    },
  });

  const run = harness.prompt("hello");
  await harness.setTitle("Manual");
  releaseTitle.resolve();
  await run;
  await eventually(() => assert.equal(harness.title, "Manual"));
});

test("reopened unknown-title Session with an existing user message is not regenerated", async () => {
  const storageDir = join(tmpdir(), `kea-harness-title-${randomUUID()}`);
  await mkdir(storageDir, { recursive: true });
  try {
    const first = await Session.create(storageDir, sessionInput());
    const { harness: firstHarness } = makeHarness({
      session: first,
      titleGenerator: async () => "First title",
    });
    await firstHarness.prompt("hello");
    await eventually(() => assert.equal(firstHarness.title, "First title"));

    const reopened = await Session.open(storageDir, first.id);
    let titleCalls = 0;
    const { harness: reopenedHarness } = makeHarness({
      session: reopened,
      titleGenerator: async () => {
        titleCalls++;
        return "regenerated";
      },
    });
    await reopenedHarness.prompt("again");
    assert.equal(titleCalls, 0);
    assert.equal(reopenedHarness.title, "First title");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a later turn after first-attempt failure does not restart title generation", async () => {
  const session = memorySession();
  let calls = 0;
  const { harness } = makeHarness({
    session,
    titleGenerator: async () => {
      calls++;
      throw new Error("failed");
    },
  });

  await harness.prompt("hello");
  await harness.prompt("world");
  assert.equal(calls, 1);
});

test("model switched before the first prompt applies to title generation", async () => {
  const session = memorySession();
  let titleModel: ModelConfig | undefined;
  const { harness } = makeHarness({
    session,
    titleGenerator: async (_prompt, model) => {
      titleModel = model;
      return "titled";
    },
  });

  await harness.switchModel(modelB);
  await harness.prompt("hello");
  await eventually(() => assert.deepEqual(titleModel, modelB));
});
