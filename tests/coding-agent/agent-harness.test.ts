import assert from "node:assert/strict";
import test from "node:test";

import { AgentHarness } from "../../src/agent/harness/agent-harness.js";
import { Session } from "../../src/agent/harness/session/session.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
import { AgentTool } from "../../src/agent/tools/types.js";
import type { AgentEvent } from "../../src/agent/types.js";
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

function createHarness(options: {
  session?: Session;
  streamFn?: StreamFn;
  systemPrompt?: () => string | Promise<string>;
} = {}): AgentHarness {
  return new AgentHarness({
    session: options.session ?? Session.inMemory(),
    model: modelA,
    streamFn: options.streamFn ?? stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: options.systemPrompt ?? (() => "system"),
    cwd: process.cwd(),
  });
}

// ── Step 1: Basic prompt/subscribe ──

test("prompt resolves after publishing Agent events", async () => {
  const harness = createHarness();
  const events: AgentEvent["type"][] = [];
  harness.subscribe((event) => {
    events.push(event.type);
  });

  await harness.prompt("hello");

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "text_delta",
    "turn_end",
    "agent_end",
  ]);
  assert.equal(harness.isRunning, false);
  assert.deepEqual(harness.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

test("messages are in Session before subscribers observe their event", async () => {
  const session = Session.inMemory();
  const harness = createHarness({ session });
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
  const harness = createHarness();
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
  const harness = createHarness();
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
  const harness = createHarness();
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
    "first:agent_start",
    "second:agent_start",
    "first:turn_start",
  ]);
});

test("subscriber failure rejects prompt and restores idle", async () => {
  const harness = createHarness();
  const failure = new Error("listener failed");
  harness.subscribe((event) => {
    if (event.type === "turn_start") throw failure;
  });

  await assert.rejects(harness.prompt("hello"), (error) => error === failure);
  assert.equal(harness.isRunning, false);
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
  const harness = createHarness({
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
  const harness = createHarness({
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
  const session = Session.inMemory();
  await session.appendModelChange(modelB);
  const harness = createHarness({ session });
  assert.deepEqual(harness.model, modelB);

  await harness.switchModel(modelA);
  assert.deepEqual(harness.model, modelA);
  assert.deepEqual(session.buildContext().model, modelA);
});

test("failed model persistence leaves current model unchanged", async () => {
  const session = Session.inMemory();
  const harness = createHarness({ session });
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
    session: Session.inMemory(),
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
  const harness = createHarness({
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
