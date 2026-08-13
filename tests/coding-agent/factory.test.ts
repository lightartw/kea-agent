import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createCodingAgent } from "../../src/coding-agent/factory.js";
import { SessionError } from "../../src/harness/session/types.js";
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

const oneTurnStream: StreamFn = async function* () {
  yield { type: "done", message: assistant };
};

test("factory composes workDir, default tools, and string prompt", async () => {
  const storageDir = await tempStorage();
  try {
    let seenPrompt = "";
    let seenTools: string[] = [];
    const stream: StreamFn = async function* (_model, context) {
      seenPrompt = context.systemPrompt ?? "";
      seenTools = context.tools?.map((tool) => tool.name) ?? [];
      yield { type: "done", message: assistant };
    };

    const codingAgent = await createCodingAgent({
      project: { workDir: "C:/workspace/project", storageDir },
      streamFn: stream,
      model,
      systemPrompt: "cwd={{cwd}} date={{date}}",
    });
    const harness = await codingAgent.createSession();

    await harness.prompt("hello");
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
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("factory resolves relative Project paths once", async () => {
  const originalCwd = process.cwd();
  const storageDir = await tempStorage();
  const firstDir = join(storageDir, "first");
  const secondDir = join(storageDir, "second");
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  let seenPrompt = "";

  try {
    process.chdir(storageDir);
    const codingAgent = await createCodingAgent({
      project: { workDir: "first", storageDir: "history" },
      streamFn: async function* (_model, context) {
        seenPrompt = context.systemPrompt ?? "";
        yield { type: "done", message: assistant };
      },
      model,
      systemPrompt: "cwd={{cwd}}",
    });

    process.chdir(secondDir);
    const harness = await codingAgent.createSession();
    await harness.prompt("hello");

    assert.equal(seenPrompt, `cwd=${firstDir}`);
    assert.deepEqual(await codingAgent.listSessions(), [harness.sessionId]);
  } finally {
    process.chdir(originalCwd);
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("factory restores a Session opened through the CodingAgent", async () => {
  const storageDir = await tempStorage();
  try {
    const seenRoles: string[][] = [];
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: async function* (_model, context) {
        seenRoles.push(context.messages.map((message) => message.role));
        yield { type: "done", message: assistant };
      },
      model,
    });

    const first = await codingAgent.createSession();
    await first.prompt("old");
    const restored = await codingAgent.openSession(first.sessionId);
    await restored.prompt("new");

    assert.deepEqual(seenRoles, [
      ["user"],
      ["user", "assistant", "user"],
    ]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("CodingAgent lists, creates, opens, and continues project Sessions", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });

    assert.deepEqual(await codingAgent.listSessions(), []);

    const created = await codingAgent.createSession();
    await created.prompt("persist me");
    assert.deepEqual(await codingAgent.listSessions(), [created.sessionId]);

    const opened = await codingAgent.openSession(created.sessionId);
    assert.equal(opened.sessionId, created.sessionId);
    assert.deepEqual(opened.messages.map((message) => message.role), ["user", "assistant"]);

    const continued = await codingAgent.continueRecent();
    assert.equal(continued.sessionId, created.sessionId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("continueRecent creates a Session when the project has no history", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });
    const harness = await codingAgent.continueRecent();
    assert.ok(harness.sessionId.length > 0);
    assert.deepEqual(harness.messages, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("continueRecent propagates an invalid newest Session without creating a replacement", async () => {
  const storageDir = await tempStorage();
  const sessionId = "20260813T120000_corrupt";
  try {
    const sessionsDir = join(storageDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, `${sessionId}.jsonl`), "not-json\n", "utf8");
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });

    await assert.rejects(
      codingAgent.continueRecent(),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );
    assert.deepEqual(await codingAgent.listSessions(), [sessionId]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("Harnesses created for one Project do not share mutable state", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });
    const first = await codingAgent.createSession();
    const second = await codingAgent.createSession();

    await first.switchModel({ provider: "test", model: "other" });
    assert.deepEqual(second.model, model);

    const secondEvents: string[] = [];
    second.subscribe((event) => { secondEvents.push(event.type); });
    await first.prompt("only first");
    assert.deepEqual(secondEvents, []);
    assert.deepEqual(second.messages, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
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
  const storageDir = await tempStorage();
  try {
    const { interactions, notifications } = recordingInteractions();
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
      interactions,
    });
    const harness = await codingAgent.createSession();

    await harness.prompt("hello");
    assert.deepEqual(notifications, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("factory defaults to fail-closed interactions for ask commands", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: twoTurnBashStream("rm file.txt"),
      model,
    });
    const harness = await codingAgent.createSession();
    await harness.prompt("remove file");
    const toolMessage = harness.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage?.role, "tool");
    assert.match(toolMessage?.content ?? "", /permission denied by user/);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
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

test("factory returns distinct Coding Agents and tool render functions per call", async () => {
  const firstStorageDir = await tempStorage();
  const secondStorageDir = await tempStorage();
  try {
    const firstConfirmations: string[] = [];
    const secondConfirmations: string[] = [];
    const first = await createCodingAgent({
      project: { workDir: "C:/first", storageDir: firstStorageDir },
      streamFn: twoTurnBashStream("rm file.txt"),
      model,
      interactions: denyingInteractions(firstConfirmations),
    });
    const second = await createCodingAgent({
      project: { workDir: "C:/second", storageDir: secondStorageDir },
      streamFn: twoTurnBashStream("rm file.txt"),
      model,
      interactions: denyingInteractions(secondConfirmations),
    });
    const firstHarness = await first.createSession();
    const secondHarness = await second.createSession();

    assert.notEqual(first, second);
    assert.notEqual(first.renderToolEvent, second.renderToolEvent);

    await firstHarness.prompt("one");
    await secondHarness.prompt("two");
    assert.deepEqual(firstConfirmations, ["permission"]);
    assert.deepEqual(secondConfirmations, ["permission"]);
  } finally {
    await rm(firstStorageDir, { recursive: true, force: true });
    await rm(secondStorageDir, { recursive: true, force: true });
  }
});

test("CodingAgent presentations render todo details from the Coding Tool definition", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
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
      codingAgent.renderToolEvent(todoEndEvent),
      "1. [in_progress] Design UI",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("default Harness system prompt contains the coding agent opening text", async () => {
  const storageDir = await tempStorage();
  try {
    let seenPrompt = "";
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: async function* (_model, context) {
        seenPrompt = context.systemPrompt ?? "";
        yield { type: "done", message: assistant };
      },
      model,
    });
    const harness = await codingAgent.createSession();

    await harness.prompt("hello");
    assert.match(seenPrompt, /You are Kea, a coding agent that runs inside a terminal/);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
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
  const storageDir = await tempStorage();
  try {
    const todos: TodoItem[] = [
      { content: "Read code", status: "completed" },
      { content: "Design UI", status: "in_progress" },
    ];
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: todoTurnStream(todos),
      model,
    });
    const harness = await codingAgent.createSession();

    await harness.prompt("plan");

    const toolMessage = harness.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role !== "tool") return;
    assert.match(toolMessage.content, /Read code/);
    assert.match(toolMessage.content, /Design UI/);
    assert.match(toolMessage.content, /completed/);
    assert.match(toolMessage.content, /in_progress/);
    assert.deepEqual(toolMessage.details, { todos });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("todo state recovers from a restored Session after a model switch", async () => {
  const storageDir = await tempStorage();
  try {
    const todos: TodoItem[] = [
      { content: "Read code", status: "completed" },
      { content: "Design UI", status: "in_progress" },
    ];
    const firstAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: todoTurnStream(todos),
      model,
    });
    const first = await firstAgent.createSession();
    await first.prompt("plan");

    let recoveredContent = "";
    const recoveryStream: StreamFn = async function* (_model, context) {
      const toolMessage = [...context.messages].reverse().find(
        (message) => message.role === "tool" && message.name === "todo_write",
      );
      recoveredContent = toolMessage?.role === "tool" ? toolMessage.content : "";
      yield { type: "done", message: assistant };
    };
    const secondAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: recoveryStream,
      model: { provider: "test", model: "model-2" },
    });
    const restored = await secondAgent.openSession(first.sessionId);
    await restored.switchModel({ provider: "test", model: "model-2" });
    await restored.prompt("resume");

    assert.match(recoveredContent, /Read code/);
    assert.match(recoveredContent, /Design UI/);
    assert.match(recoveredContent, /completed/);
    assert.match(recoveredContent, /in_progress/);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
