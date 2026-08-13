import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createHarness } from "../../src/coding-agent/factory.js";
import { Session } from "../../src/agent/harness/session/session.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";
import type {
  CodingHookUI,
  HookNotification,
} from "../../src/coding-agent/types.js";
import type { TodoItem } from "../../src/coding-agent/tools/todo-state.js";

async function tempStorage(): Promise<string> {
  const path = join(tmpdir(), `kea-factory-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

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

function recordingUi(): {
  ui: CodingHookUI;
  notifications: HookNotification[];
} {
  const notifications: HookNotification[] = [];
  return {
    notifications,
    ui: {
      available: true,
      async confirm() { return true; },
      notify(notification) { notifications.push(notification); },
    },
  };
}

const oneTurnStream: StreamFn = async function* () {
  yield { type: "done", message: assistant };
};

function twoTurnBashStream(command: string): StreamFn {
  let turn = 0;
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "bash",
    arguments: { command },
  };
  return async function* () {
    turn++;
    if (turn === 1) {
      yield { type: "toolcall_start", id: call.id, name: call.name };
      yield { type: "toolcall_end", toolCall: call };
      yield {
        type: "done",
        message: {
          ...assistant,
          content: [call],
          stopReason: "toolUse",
        },
      };
      return;
    }
    yield { type: "done", message: assistant };
  };
}

test("factory assembles the default Hook registry with supplied UI", async () => {
  const { ui, notifications } = recordingUi();
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
    ui,
  });

  await harness.prompt("hello");
  assert.equal(notifications[0]?.source, "context_inject");
  assert.equal(notifications.at(-1)?.source, "summary");
});

test("factory defaults to fail-closed NO_UI for ask commands", async () => {
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: twoTurnBashStream("rm file.txt"),
    model,
    session: Session.inMemory(),
  });
  await harness.prompt("remove file");
  const toolMessage = harness.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /no confirmation UI available/);
});

test("factory creates independent Hook context for each Harness", async () => {
  const {
    ui: firstUi,
    notifications: firstNotifications,
  } = recordingUi();
  const {
    ui: secondUi,
    notifications: secondNotifications,
  } = recordingUi();
  const first = await createHarness({
    project: { workDir: "C:/first", storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
    ui: firstUi,
  });
  const second = await createHarness({
    project: { workDir: "C:/second", storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
    ui: secondUi,
  });
  await first.prompt("one");
  await second.prompt("two");
  assert.match(firstNotifications[0]?.message ?? "", /C:\/first/);
  assert.match(secondNotifications[0]?.message ?? "", /C:\/second/);
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

function todoTurnStream(todos: readonly TodoItem[]): StreamFn {
  let turn = 0;
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "todo_write",
    arguments: { todos },
  };
  return async function* () {
    turn++;
    if (turn === 1) {
      yield { type: "toolcall_start", id: call.id, name: call.name };
      yield { type: "toolcall_end", toolCall: call };
      yield {
        type: "done",
        message: {
          ...assistant,
          content: [call],
          stopReason: "toolUse",
        },
      };
      return;
    }
    yield { type: "done", message: assistant };
  };
}

test("todo content is model-visible while details stay in the in-memory message", async () => {
  const todos: TodoItem[] = [
    { content: "Read code", status: "completed" },
    { content: "Design UI", status: "in_progress" },
  ];
  const session = Session.inMemory();
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: todoTurnStream(todos),
    model,
    session,
  });

  await harness.prompt("plan");

  const toolMessage = harness.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.role, "tool");
  if (toolMessage?.role !== "tool") return;
  assert.match(toolMessage.content, /Read code/);
  assert.match(toolMessage.content, /Design UI/);
  assert.match(toolMessage.content, /completed/);
  assert.match(toolMessage.content, /in_progress/);
  assert.deepEqual(toolMessage.details, { todos });
});

test("todo state recovers from a restored Session after a model switch", async () => {
  const storageDir = await tempStorage();
  try {
    const todos: TodoItem[] = [
      { content: "Read code", status: "completed" },
      { content: "Design UI", status: "in_progress" },
    ];
    const first = await Session.create(storageDir);
    const firstHarness = await createHarness({
      project: { workDir: process.cwd(), storageDir },
      streamFn: todoTurnStream(todos),
      model,
      session: first,
    });
    await firstHarness.prompt("plan");

    const restored = await Session.open(storageDir, first.id);
    let recoveredContent = "";
    const recoveryStream: StreamFn = async function* (_model, context) {
      const toolMessage = [...context.messages].reverse().find(
        (message) => message.role === "tool" && message.name === "todo_write",
      );
      recoveredContent = toolMessage?.role === "tool" ? toolMessage.content : "";
      yield { type: "done", message: assistant };
    };
    const secondHarness = await createHarness({
      project: { workDir: process.cwd(), storageDir },
      streamFn: recoveryStream,
      model: { provider: "test", model: "model-2" },
      session: restored,
    });
    await secondHarness.prompt("resume");

    assert.match(recoveredContent, /Read code/);
    assert.match(recoveredContent, /Design UI/);
    assert.match(recoveredContent, /completed/);
    assert.match(recoveredContent, /in_progress/);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
