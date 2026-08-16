import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { createProject } from "../../src/coding-agent/factory.js";
import type { SessionMetadata } from "../../src/core/harness/session/types.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/core/ai/types.js";
import type { CodingAgentInteractions } from "../../src/coding-agent/index.js";
import type { ToolPresentationInput } from "../../src/coding-agent/ui/presentation.js";
import type { TodoItem } from "../../src/coding-agent/tools/builtin/todo.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-project-"));
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

/** Guard the recording streams from the Tool-free background title request. */
function guardTitle(stream: StreamFn): StreamFn {
  return async function* (_model, context) {
    if (context.tools !== undefined && context.tools.length === 0) {
      yield { type: "done", message: assistant };
      return;
    }
    yield* stream(_model, context);
  };
}

function createProjectAt(keaHome: string, directory: string, options: {
  streamFn?: StreamFn;
  systemPrompt?: string;
  interactions?: CodingAgentInteractions;
} = {}) {
  return createProject({
    keaHome,
    directory,
    streamFn: guardTitle(options.streamFn ?? oneTurnStream),
    model,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.interactions !== undefined ? { interactions: options.interactions } : {}),
  });
}

test("createSession uses the primary directory with cwd .", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await createProjectAt(keaHome, dir);
    const session = await project.createSession();
    const [info] = await project.listSessions();
    assert.equal(info?.id, session.sessionId);
    assert.equal(info?.cwd, resolve(dir));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("continueRecent creates a Session at the startup cwd when empty", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const sub = join(dir, "src");
    await mkdir(sub, { recursive: true });
    await createProjectAt(keaHome, dir);
    const project = await createProject({ keaHome, cwd: sub, streamFn: oneTurnStream, model });
    const harness = await project.continueRecent();
    const [info] = await project.listSessions();
    assert.equal(info?.id, harness.sessionId);
    assert.equal(info?.cwd, resolve(sub));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("openSession rebuilds system prompt and tools from the stored cwd", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    let seenPrompt = "";
    let seenTools: string[] = [];
    const project = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(async function* (_model, context) {
        seenPrompt = context.systemPrompt ?? "";
        seenTools = context.tools?.map((tool) => tool.name) ?? [];
        yield { type: "done", message: assistant };
      }),
      model,
      systemPrompt: "cwd={{cwd}}",
    });
    const created = await project.createSession();
    await created.prompt("hello");

    const reopened = await project.openSession(created.sessionId);
    await reopened.prompt("again");
    assert.equal(seenPrompt, `cwd=${resolve(dir)}`);
    assert.deepEqual(seenTools, [
      "bash", "read_file", "write_file", "edit_file", "glob", "todo_write",
    ]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("switching primaryDirectory changes later createSession but not old headers", async () => {
  const keaHome = await tempDir();
  const dirA = await tempDir();
  const dirB = await tempDir();
  try {
    const project = await createProjectAt(keaHome, dirA);
    const first = await project.createSession();
    const [firstInfo] = await project.listSessions();
    assert.equal(firstInfo?.cwd, resolve(dirA));

    await project.update({ primaryDirectory: resolve(dirB), directories: [resolve(dirA), resolve(dirB)] });
    const second = await project.createSession();
    const [secondInfo, ...rest] = await project.listSessions();
    assert.equal(secondInfo?.cwd, resolve(dirB));
    assert.equal(rest[0]?.id, first.sessionId);
    assert.equal(rest[0]?.cwd, resolve(dirA));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("Project.update survives a second createProject call", async () => {
  const keaHome = await tempDir();
  const dirA = await tempDir();
  const dirB = await tempDir();
  try {
    const first = await createProjectAt(keaHome, dirA);
    await first.update({
      name: "research",
      directories: [resolve(dirA), resolve(dirB)],
      primaryDirectory: resolve(dirB),
    });

    const reopened = await createProjectAt(keaHome, dirA);
    assert.equal(reopened.id, first.id);
    assert.equal(reopened.name, "research");
    assert.equal(reopened.primaryDirectory, resolve(dirB));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("openSession rejects removed directories and missing cwd", async () => {
  const keaHome = await tempDir();
  const dirA = await tempDir();
  const dirB = await tempDir();
  try {
    const projectA = await createProjectAt(keaHome, dirA);

    // Directory removed from the Project after the Session was created.
    const beforeRemove = await projectA.createSession();
    await beforeRemove.prompt("x");
    const removedId = beforeRemove.sessionId;
    await projectA.update({
      directories: [resolve(dirB)],
      primaryDirectory: resolve(dirB),
    });
    await assert.rejects(
      projectA.openSession(removedId),
      /escapes the Project directories/,
    );

    // Resolved cwd no longer exists on disk.
    const goneDir = join(dirB, "gone");
    await mkdir(goneDir, { recursive: true });
    const missing = await projectA.createSession({ cwd: "gone" });
    await rm(goneDir, { recursive: true, force: true });
    await assert.rejects(
      projectA.openSession(missing.sessionId),
      /does not exist/,
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("project restores a Session opened through the Project", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const seenRoles: string[][] = [];
    const project = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(async function* (_model, context) {
        seenRoles.push(context.messages.map((message) => message.role));
        yield { type: "done", message: assistant };
      }),
      model,
    });

    const first = await project.createSession();
    await first.prompt("old");
    const restored = await project.openSession(first.sessionId);
    await restored.prompt("new");

    assert.deepEqual(seenRoles, [
      ["user"],
      ["user", "assistant", "user"],
    ]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("project lists, creates, opens, and continues Sessions", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await createProjectAt(keaHome, dir);
    assert.deepEqual(await project.listSessions(), []);

    const created = await project.createSession();
    await created.prompt("persist me");
    const [info] = await project.listSessions();
    assert.equal(info?.id, created.sessionId);

    const opened = await project.openSession(created.sessionId);
    assert.equal(opened.sessionId, created.sessionId);
    assert.deepEqual(opened.messages.map((message) => message.role), ["user", "assistant"]);

    const continued = await project.continueRecent();
    assert.equal(continued.sessionId, created.sessionId);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("continueRecent propagates an invalid newest Session", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await createProjectAt(keaHome, dir);
    const created = await project.createSession();
    await created.prompt("x");
    const sessionsDir = join(keaHome, "projects", project.id, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "corrupt.jsonl"), "not-json\n", "utf8");

    await assert.rejects(
      project.continueRecent(),
      /invalid/,
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("Harnesses created for one Project do not share mutable state", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const seenTools: string[][] = [];
    const project = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(async function* (_model, context) {
        seenTools.push(context.tools?.map((tool) => tool.name) ?? []);
        yield { type: "done", message: assistant };
      }),
      model,
    });
    const first = await project.createSession();
    const second = await project.createSession();

    await first.switchModel({ provider: "test", model: "other" });
    assert.deepEqual(second.model, model);

    const secondEvents: string[] = [];
    project.events.on("agent/turn-start", (input) => {
      if (input.sessionId === second.sessionId) secondEvents.push("turn");
    });
    first.unregisterTool("bash");
    await first.prompt("only first");
    assert.deepEqual(secondEvents, []);
    assert.deepEqual(second.messages, []);
    await second.prompt("only second");
    assert.deepEqual(seenTools, [
      ["read_file", "write_file", "edit_file", "glob", "todo_write"],
      ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write"],
    ]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
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

test("project registers the default permission listener with supplied interactions", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const { interactions, notifications } = recordingInteractions();
    const project = await createProjectAt(keaHome, dir, { interactions });
    const harness = await project.createSession();

    await harness.prompt("hello");
    assert.deepEqual(notifications, []);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("project defaults to fail-closed interactions for ask commands", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(twoTurnBashStream("rm file.txt")),
      model,
    });
    const harness = await project.createSession();
    await harness.prompt("remove file");
    const toolMessage = harness.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage?.role, "tool");
    assert.match(toolMessage?.content ?? "", /permission denied by user/);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
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

test("createProject returns distinct Projects and tool render functions per call", async () => {
  const keaHomeA = await tempDir();
  const keaHomeB = await tempDir();
  const dirA = await tempDir();
  const dirB = await tempDir();
  try {
    const firstConfirmations: string[] = [];
    const secondConfirmations: string[] = [];
    const first = await createProject({
      keaHome: keaHomeA,
      directory: dirA,
      streamFn: guardTitle(twoTurnBashStream("rm file.txt")),
      model,
      interactions: denyingInteractions(firstConfirmations),
    });
    const second = await createProject({
      keaHome: keaHomeB,
      directory: dirB,
      streamFn: guardTitle(twoTurnBashStream("rm file.txt")),
      model,
      interactions: denyingInteractions(secondConfirmations),
    });
    const firstHarness = await first.createSession();
    const secondHarness = await second.createSession();

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.renderTool, second.renderTool);

    await firstHarness.prompt("one");
    await secondHarness.prompt("two");
    assert.deepEqual(firstConfirmations, ["permission"]);
    assert.deepEqual(secondConfirmations, ["permission"]);
  } finally {
    await rm(keaHomeA, { recursive: true, force: true });
    await rm(keaHomeB, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("project presentations render todo details from the Tool definition", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await createProjectAt(keaHome, dir);

    const todoResultEvent: ToolPresentationInput = {
      type: "result",
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
      project.renderTool(todoResultEvent),
      "1. [in_progress] Design UI",
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("default Harness system prompt contains the coding agent opening text", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    let seenPrompt = "";
    const project = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(async function* (_model, context) {
        seenPrompt = context.systemPrompt ?? "";
        yield { type: "done", message: assistant };
      }),
      model,
    });
    const harness = await project.createSession();

    await harness.prompt("hello");
    assert.match(seenPrompt, /You are Kea, a coding agent that runs inside a terminal/);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
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
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const todos: TodoItem[] = [
      { content: "Read code", status: "completed" },
      { content: "Design UI", status: "in_progress" },
    ];
    const project = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(todoTurnStream(todos)),
      model,
    });
    const harness = await project.createSession();

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
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("todo state recovers from a restored Session after a model switch", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const todos: TodoItem[] = [
      { content: "Read code", status: "completed" },
      { content: "Design UI", status: "in_progress" },
    ];
    const firstProject = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(todoTurnStream(todos)),
      model,
    });
    const first = await firstProject.createSession();
    await first.prompt("plan");

    let recoveredContent = "";
    const recoveryStream: StreamFn = async function* (_model, context) {
      const toolMessage = [...context.messages].reverse().find(
        (message) => message.role === "tool" && message.name === "todo_write",
      );
      recoveredContent = toolMessage?.role === "tool" ? toolMessage.content : "";
      yield { type: "done", message: assistant };
    };
    const secondProject = await createProject({
      keaHome,
      directory: dir,
      streamFn: guardTitle(recoveryStream),
      model: { provider: "test", model: "model-2" },
    });
    const restored = await secondProject.openSession(first.sessionId);
    await restored.switchModel({ provider: "test", model: "model-2" });
    await restored.prompt("resume");

    assert.match(recoveredContent, /Read code/);
    assert.match(recoveredContent, /Design UI/);
    assert.match(recoveredContent, /completed/);
    assert.match(recoveredContent, /in_progress/);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Task 5: Project event sharing and isolation ──

test("one Project shares one Events instance across all Sessions", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await createProjectAt(keaHome, dir);
    const first = await project.createSession();
    const second = await project.createSession();

    const facts: string[] = [];
    project.events.on("agent/turn-start", (input) => {
      facts.push(input.sessionId);
    });

    await first.prompt("one");
    await second.prompt("two");

    assert.deepEqual(facts, [first.sessionId, second.sessionId]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second Project's listeners receive none of the first Project's facts", async () => {
  const keaHomeA = await tempDir();
  const keaHomeB = await tempDir();
  const dirA = await tempDir();
  const dirB = await tempDir();
  try {
    const projectA = await createProjectAt(keaHomeA, dirA);
    const projectB = await createProjectAt(keaHomeB, dirB);
    const harnessA = await projectA.createSession();
    const harnessB = await projectB.createSession();

    const bFacts: string[] = [];
    projectB.events.on("agent/turn-start", (input) => {
      bFacts.push(input.sessionId);
    });

    await harnessA.prompt("one");
    assert.deepEqual(bFacts, []);

    await harnessB.prompt("two");
    assert.deepEqual(bFacts, [harnessB.sessionId]);
  } finally {
    await rm(keaHomeA, { recursive: true, force: true });
    await rm(keaHomeB, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
