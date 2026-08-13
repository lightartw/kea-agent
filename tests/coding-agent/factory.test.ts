import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createCodingAgent } from "../../src/coding-agent/factory.js";
import { Session } from "../../src/harness/session/session.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";
import type { CodingAgentInteractions } from "../../src/coding-agent/index.js";
import type { HarnessToolEvent } from "../../src/harness/events/types.js";
import type { TodoItem } from "../../src/coding-agent/tools/builtin/todo.js";

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

  const runtime = await createCodingAgent({
    project: {
      workDir: "C:/workspace/project",
      storageDir: "unused-because-session-is-in-memory",
    },
    streamFn: stream,
    model,
    session: Session.inMemory(),
    systemPrompt: "cwd={{cwd}} date={{date}}",
  });

  await runtime.harness.prompt("hello");
  assert.equal(
    seenPrompt,
    `cwd=${resolve("C:/workspace/project")} date=${new Date().toISOString().slice(0, 10)}`,
  );
  assert.deepEqual(seenTools, [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "todo_write",
  ]);
});

test("factory resolves a relative workDir once", async () => {
  const originalCwd = process.cwd();
  const storageDir = await tempStorage();
  const firstDir = join(storageDir, "first");
  const secondDir = join(storageDir, "second");
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  let seenPrompt = "";

  try {
    process.chdir(storageDir);
    const runtime = await createCodingAgent({
      project: { workDir: "first", storageDir: "unused" },
      streamFn: async function* (_model, context) {
        seenPrompt = context.systemPrompt ?? "";
        yield { type: "done", message: assistant };
      },
      model,
      session: Session.inMemory(),
      systemPrompt: "cwd={{cwd}}",
    });

    process.chdir(secondDir);
    await runtime.harness.prompt("hello");

    assert.equal(seenPrompt, `cwd=${firstDir}`);
  } finally {
    process.chdir(originalCwd);
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("factory restores the supplied Session", async () => {
  const session = Session.inMemory();
  await session.appendMessage({ role: "user", content: "old" });
  await session.appendMessage(assistant);

  let seenRoles: string[] = [];
  const runtime = await createCodingAgent({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: async function* (_model, context) {
      seenRoles = context.messages.map((message) => message.role);
      yield { type: "done", message: assistant };
    },
    model,
    session,
  });

  await runtime.harness.prompt("new");
  assert.deepEqual(seenRoles, ["user", "assistant", "user"]);
});

function recordingInteractions(): {
  interactions: CodingAgentInteractions;
  notifications: string[];
} {
  const notifications: string[] = [];
  return {
    notifications,
    interactions: {
      async confirm() { return true; },
      notify(notification) { notifications.push(notification.source); },
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

test("factory assembles the default built-in Hook registry with supplied interactions", async () => {
  const { interactions, notifications } = recordingInteractions();
  const runtime = await createCodingAgent({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
    interactions,
  });

  await runtime.harness.prompt("hello");
  assert.deepEqual(notifications, []);
});

test("factory defaults to fail-closed interactions for ask commands", async () => {
  const runtime = await createCodingAgent({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: twoTurnBashStream("rm file.txt"),
    model,
    session: Session.inMemory(),
  });
  await runtime.harness.prompt("remove file");
  const toolMessage = runtime.harness.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /permission denied by user/);
});

function denyingInteractions(confirmations: string[]): CodingAgentInteractions {
  return {
    async confirm(request) {
      confirmations.push(request.source);
      return false;
    },
    notify() {},
  };
}

test("factory returns distinct harnesses and tool render functions per call", async () => {
  const firstConfirmations: string[] = [];
  const secondConfirmations: string[] = [];
  const first = await createCodingAgent({
    project: { workDir: "C:/first", storageDir: "unused" },
    streamFn: twoTurnBashStream("rm file.txt"),
    model,
    session: Session.inMemory(),
    interactions: denyingInteractions(firstConfirmations),
  });
  const second = await createCodingAgent({
    project: { workDir: "C:/second", storageDir: "unused" },
    streamFn: twoTurnBashStream("rm file.txt"),
    model,
    session: Session.inMemory(),
    interactions: denyingInteractions(secondConfirmations),
  });

  assert.notEqual(first.harness, second.harness);
  assert.notEqual(first.renderToolEvent, second.renderToolEvent);

  await first.harness.prompt("one");
  await second.harness.prompt("two");
  assert.deepEqual(firstConfirmations, ["permission"]);
  assert.deepEqual(secondConfirmations, ["permission"]);
});

test("runtime presentations render todo details from the Coding Tool definition", async () => {
  const runtime = await createCodingAgent({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: oneTurnStream,
    model,
    session: Session.inMemory(),
  });

  const todoEndEvent: HarnessToolEvent = {
    type: "tool_end",
    lane: "main",
    runId: "run-1",
    call: {
      type: "toolCall",
      id: "c1",
      name: "todo_write",
      arguments: { todos: [{ content: "Design UI", status: "in_progress" }] },
    },
    result: {
      content: "Current tasks:\n1. [in_progress] Design UI\nUpdated 1 tasks",
      details: { todos: [{ content: "Design UI", status: "in_progress" }] },
      isError: false,
    },
  };
  assert.equal(
    runtime.renderToolEvent(todoEndEvent),
    "1. [in_progress] Design UI",
  );
});

test("default Harness system prompt contains the coding agent opening text", async () => {
  let seenPrompt = "";
  const runtime = await createCodingAgent({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: async function* (_model, context) {
      seenPrompt = context.systemPrompt ?? "";
      yield { type: "done", message: assistant };
    },
    model,
    session: Session.inMemory(),
  });

  await runtime.harness.prompt("hello");
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
  const runtime = await createCodingAgent({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: todoTurnStream(todos),
    model,
    session,
  });

  await runtime.harness.prompt("plan");

  const toolMessage = runtime.harness.messages.find((message) => message.role === "tool");
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
    const firstRuntime = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: todoTurnStream(todos),
      model,
      session: first,
    });
    await firstRuntime.harness.prompt("plan");

    const restored = await Session.open(storageDir, first.id);
    let recoveredContent = "";
    const recoveryStream: StreamFn = async function* (_model, context) {
      const toolMessage = [...context.messages].reverse().find(
        (message) => message.role === "tool" && message.name === "todo_write",
      );
      recoveredContent = toolMessage?.role === "tool" ? toolMessage.content : "";
      yield { type: "done", message: assistant };
    };
    const secondRuntime = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: recoveryStream,
      model: { provider: "test", model: "model-2" },
      session: restored,
    });
    await secondRuntime.harness.prompt("resume");

    assert.match(recoveredContent, /Read code/);
    assert.match(recoveredContent, /Design UI/);
    assert.match(recoveredContent, /completed/);
    assert.match(recoveredContent, /in_progress/);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
