import assert from "node:assert/strict";
import test from "node:test";

import { createHarness } from "../../src/coding-agent/factory.js";
import { Session } from "../../src/agent/harness/session/session.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";

const model: ModelConfig = { provider: "test", model: "model" };
const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

test("factory composes workDir, default tools, and string prompt", async () => {
  let seenPrompt = "";
  let seenTools: string[] = [];
  const stream: StreamFn = async function* (_model, context) {
    seenPrompt = context.systemPrompt ?? "";
    seenTools = context.tools?.map((tool) => tool.name) ?? [];
    yield { type: "done", message: assistant };
  };

  const harness = await createHarness({
    project: {
      workDir: "C:/workspace/project",
      storageDir: "unused-because-session-is-in-memory",
    },
    streamFn: stream,
    model,
    session: Session.inMemory(),
    systemPrompt: "cwd={{cwd}} date={{date}}",
  });

  await harness.prompt("hello");
  assert.match(seenPrompt, /^cwd=C:\/workspace\/project date=\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(seenTools, [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "todo_write",
  ]);
});

test("factory restores the supplied Session", async () => {
  const session = Session.inMemory();
  await session.appendMessage({ role: "user", content: "old" });
  await session.appendMessage(assistant);

  let seenRoles: string[] = [];
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: async function* (_model, context) {
      seenRoles = context.messages.map((message) => message.role);
      yield { type: "done", message: assistant };
    },
    model,
    session,
  });

  await harness.prompt("new");
  assert.deepEqual(seenRoles, ["user", "assistant", "user"]);
});

test("default Harness composition emits no Hook console logs", async () => {
  const logs: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args);
  };
  try {
    const harness = await createHarness({
      project: { workDir: process.cwd(), storageDir: "unused" },
      streamFn: async function* () {
        yield { type: "done", message: assistant };
      },
      model,
      session: Session.inMemory(),
    });
    await harness.prompt("hello");
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logs, []);
});

test("default Harness system prompt contains the coding agent opening text", async () => {
  let seenPrompt = "";
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: async function* (_model, context) {
      seenPrompt = context.systemPrompt ?? "";
      yield { type: "done", message: assistant };
    },
    model,
    session: Session.inMemory(),
  });

  await harness.prompt("hello");
  assert.match(seenPrompt, /You are Kea, a coding agent that runs inside a terminal/);
});
