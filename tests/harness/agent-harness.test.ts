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
import type { AgentEvent } from "../../src/agent/types.js";
import { HookRegistry } from "../../src/agent/hooks/registry.js";
import type { AgentHookTrigger } from "../../src/agent/hooks/types.js";
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
  hooks?: AgentHookTrigger;
  titleGenerator?: SessionTitleGenerator;
} = {}): AgentHarness {
  const base: Omit<HarnessConfig, "hooks"> = {
    session: options.session ?? memorySession(),
    model: modelA,
    streamFn: options.streamFn ?? stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: options.systemPrompt ?? (() => "system"),
    cwd: process.cwd(),
  };
  if (options.hooks !== undefined) {
    return new AgentHarness({
      ...base,
      hooks: options.hooks,
      ...(options.titleGenerator !== undefined ? { titleGenerator: options.titleGenerator } : {}),
    });
  }
  return new AgentHarness({
    ...base,
    ...(options.titleGenerator !== undefined ? { titleGenerator: options.titleGenerator } : {}),
  });
}

test("sessionId exposes the bound Session identity", () => {
  const session = memorySession();
  const harness = makeHarness({ session });

  assert.equal(harness.sessionId, session.id);
});

// ── Step 1: Basic prompt/subscribe ──

test("prompt resolves after publishing Harness events", async () => {
  const harness = makeHarness();
  const events: string[] = [];
  harness.subscribe((event) => {
    events.push(event.type);
  });

  await harness.prompt("hello");

  assert.deepEqual(events, [
    "run_start",
    "agent_start",
    "turn_start",
    "text_delta",
    "turn_end",
    "agent_end",
    "run_end",
  ]);
  assert.equal(harness.isRunning, false);
  assert.deepEqual(harness.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

test("messages are in Session before subscribers observe their event", async () => {
  const session = memorySession();
  const harness = makeHarness({ session });
  harness.subscribe((event) => {
    if (event.type === "turn_start") {
      assert.deepEqual(
        session.buildContext().messages.map((message) => message.role),
        ["user"],
      );
    }
    if (event.type === "turn_end") {
      assert.deepEqual(
        session.buildContext().messages.map((message) => message.role),
        ["user", "assistant"],
      );
    }
  });
  await harness.prompt("hello");
});

// ── Step 2: Subscription ordering, failure, unsubscribe ──

test("subscribers are awaited in registration order", async () => {
  const harness = makeHarness();
  const calls: string[] = [];
  harness.subscribe(async (event) => {
    if (event.type !== "agent_start") return;
    await Promise.resolve();
    calls.push("first");
  });
  harness.subscribe((event) => {
    if (event.type === "agent_start") calls.push("second");
  });

  await harness.prompt("hello");
  assert.deepEqual(calls, ["first", "second"]);
});

test("unsubscribe is idempotent", async () => {
  const harness = makeHarness();
  let calls = 0;
  const unsubscribe = harness.subscribe(() => {
    calls++;
  });
  unsubscribe();
  unsubscribe();

  await harness.prompt("hello");
  assert.equal(calls, 0);
});

test("subscription changes take effect on the next event", async () => {
  const harness = makeHarness();
  const calls: string[] = [];
  let removeSecond = () => {};
  harness.subscribe((event) => {
    calls.push(`first:${event.type}`);
    removeSecond();
  });
  removeSecond = harness.subscribe((event) => {
    calls.push(`second:${event.type}`);
  });

  await harness.prompt("hello");

  assert.deepEqual(calls.slice(0, 3), [
    "first:run_start",
    "second:run_start",
    "first:agent_start",
  ]);
});

test("listener failure is isolated and does not reject prompt", async () => {
  const harness = makeHarness();
  const calls: string[] = [];
  harness.subscribe((event) => {
    if (event.type !== "run_start") return;
    calls.push("first");
    throw new Error("listener failed");
  });
  harness.subscribe((event) => {
    if (event.type === "run_end") calls.push("second");
  });

  await harness.prompt("hello");
  assert.equal(harness.isRunning, false);
  assert.deepEqual(calls, ["first", "second"]);
});

test("abort from run_start prevents the Agent execution", async () => {
  let streamCalls = 0;
  const harness = makeHarness({
    streamFn: async function* () {
      streamCalls++;
      yield { type: "done", message: assistant };
    },
  });
  const events: string[] = [];
  harness.subscribe((event) => {
    events.push(event.type === "run_end"
      ? `${event.type}:${event.reason}`
      : event.type);
    if (event.type === "run_start") harness.abort();
  });

  await harness.prompt("hello");

  assert.equal(streamCalls, 0);
  assert.deepEqual(events, ["run_start", "run_end:aborted"]);
  assert.deepEqual(harness.messages, []);
});

test("persistence failure still publishes one run_end error", async () => {
  const session = memorySession();
  session.appendMessage = async () => {
    throw new Error("storage failed");
  };
  const harness = makeHarness({ session });
  const events: string[] = [];
  harness.subscribe((event) => {
    events.push(event.type === "run_end"
      ? `${event.type}:${event.reason}`
      : event.type);
  });

  await assert.rejects(harness.prompt("hello"), /storage failed/);

  assert.deepEqual(events, ["run_start", "agent_start", "run_end:error"]);
  assert.equal(harness.isRunning, false);
});

async function captureRun(): Promise<Array<{ type: string; lane: string; runId: string }>> {
  const harness = makeHarness();
  const events: Array<{ type: string; lane: string; runId: string }> = [];
  harness.subscribe((event) => {
    events.push({ type: event.type, lane: event.lane, runId: event.runId });
  });
  await harness.prompt("hello");
  return events;
}

test("run identity wraps every event and differs across runs", async () => {
  const first = await captureRun();
  const second = await captureRun();

  assert.equal(first[0]?.type, "run_start");
  assert.equal(first.at(-1)?.type, "run_end");
  assert.ok(first.every((event) => event.lane === "main"));
  assert.equal(new Set(first.map((event) => event.runId)).size, 1);
  assert.notEqual(first[0]?.runId, second[0]?.runId);
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
  const harness = makeHarness({
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
  const harness = makeHarness({
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
  const harness = makeHarness({ session });
  assert.deepEqual(harness.model, modelB);

  await harness.switchModel(modelA);
  assert.deepEqual(harness.model, modelA);
  assert.deepEqual(session.buildContext().model, modelA);
});

test("failed model persistence leaves current model unchanged", async () => {
  const session = memorySession();
  const harness = makeHarness({ session });
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
  const harness = makeHarness({
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

  const run = harness.prompt("hello");
  await started.promise;
  harness.abort();
  await run;

  assert.equal(harness.isRunning, false);
  const lastMessage = harness.messages.at(-1);
  assert.equal(
    lastMessage?.role === "assistant"
      ? lastMessage.stopReason
      : undefined,
    "aborted",
  );
});

// ── Task 4: Harness Hook pass-through tests ──

test("Harness passes one Hook trigger to Agent Loop", async () => {
  const hooks = new HookRegistry<{ calls: string[] }>({
    calls: [],
  });
  hooks.register("user_prompt", (_event, context) => {
    context.calls.push("user_prompt");
  });
  hooks.register("context", (_event, context) => {
    context.calls.push("context");
  });
  hooks.register("stop", (_event, context) => {
    context.calls.push("stop");
  });

  const harness = makeHarness({ hooks });
  await harness.prompt("hello");
  assert.deepEqual(hooks.context.calls, [
    "user_prompt", "context", "stop",
  ]);
});

test("user_prompt and context Hook failures reject prompt and restore idle", async () => {
  for (const type of ["user_prompt", "context"] as const) {
    const hooks = new HookRegistry<Record<string, never>>({});
    hooks.register(type, () => { throw new Error(`${type} failed`); });
    const harness = makeHarness({ hooks });

    await assert.rejects(harness.prompt("hello"), new RegExp(`${type} failed`));
    assert.equal(harness.isRunning, false);
  }
});

test("stop Hook failure keeps the completed assistant message and restores idle", async () => {
  const hooks = new HookRegistry<Record<string, never>>({});
  hooks.register("stop", () => { throw new Error("stop failed"); });
  const harness = makeHarness({ hooks });

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

  const harness = new AgentHarness({
    session,
    model: modelA,
    streamFn,
    toolRegistry: registry,
    systemPrompt: () => "system",
    cwd: process.cwd(),
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  harness.subscribe((event) => {
    if (event.type === "tool_end" || event.type === "tool_rejected") {
      const message = session.buildContext().messages.find(
        (entry) => entry.role === "tool" && entry.toolCallId === "c1",
      );
      const matches = message !== undefined && message.role === "tool" &&
        message.content === event.result.content &&
        JSON.stringify(message.details) === JSON.stringify(event.result.details);
      observed.push({ type: event.type, matches });
    }
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

  const harness = new AgentHarness({
    session,
    model: modelA,
    streamFn,
    toolRegistry: registry,
    systemPrompt: () => "system",
    cwd: process.cwd(),
  });

  const observed: Array<{ type: string; matches: boolean }> = [];
  harness.subscribe((event) => {
    if (event.type === "tool_end" || event.type === "tool_rejected") {
      const message = session.buildContext().messages.find(
        (entry) => entry.role === "tool" && entry.toolCallId === "c1",
      );
      const matches = message !== undefined &&
        message.content === event.result.content;
      observed.push({ type: event.type, matches });
    }
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
  const harness = makeHarness({
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
  const hooks = new HookRegistry<Record<string, never>>({});
  hooks.register("user_prompt", () => ({ block: true, reason: "blocked" }));
  const harness = makeHarness({
    session,
    hooks,
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
  const harness = makeHarness({
    session,
    titleGenerator: async () => {
      throw new Error("title model failed");
    },
  });

  const events: string[] = [];
  harness.subscribe((event) => { events.push(event.type); });
  await harness.prompt("hello");
  assert.deepEqual(events, [
    "run_start", "agent_start", "turn_start", "text_delta", "turn_end", "agent_end", "run_end",
  ]);
  assert.equal(harness.title, "unknown");
});

test("generator output is trimmed to one line and capped", async () => {
  const session = memorySession();
  const harness = makeHarness({
    session,
    titleGenerator: async () => `${"x".repeat(120)}\nignored line`,
  });

  await harness.prompt("hello");
  await eventually(() => assert.equal(harness.title, `${"x".repeat(97)}...`));
});

test("manual rename racing with generated output is never overwritten", async () => {
  const releaseTitle = deferred();
  const session = memorySession();
  const harness = makeHarness({
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
    const firstHarness = makeHarness({
      session: first,
      titleGenerator: async () => "First title",
    });
    await firstHarness.prompt("hello");
    await eventually(() => assert.equal(firstHarness.title, "First title"));

    const reopened = await Session.open(storageDir, first.id);
    let titleCalls = 0;
    const reopenedHarness = makeHarness({
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
  const harness = makeHarness({
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
  const harness = makeHarness({
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
