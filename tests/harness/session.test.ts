import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import type { ModelConfig } from "../../src/ai/types.js";
import { Session, sessionsDir } from "../../src/harness/session/session.js";
import { SessionError, type CreateSessionInput } from "../../src/harness/session/types.js";
import { detailedToolResult } from "../ai/fixtures.js";

const modelA: ModelConfig = { provider: "test-a", model: "model-a" };
const modelB: ModelConfig = { provider: "test-b", model: "model-b" };
const user: AgentMessage = { role: "user", content: "hello" };
const assistant: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "world" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

async function tempStorage(): Promise<string> {
  const path = join(tmpdir(), `kea-session-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

function input(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    projectId: "project_test",
    directory: process.cwd(),
    cwd: ".",
    ...overrides,
  };
}

function memorySession(): Session {
  return Session.inMemory(input());
}

async function readRecords(storageDir: string, sessionId: string): Promise<unknown[]> {
  const path = join(sessionsDir(storageDir), `${sessionId}.jsonl`);
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

const isInvalidSession = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "invalid_session";

test("create immediately writes an unknown-title Session header", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir, input({ cwd: "src" }));
    const records = await readRecords(storageDir, session.id);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      type: "session",
      version: 1,
      id: session.id,
      projectId: input().projectId,
      title: "unknown",
      directory: resolve(input().directory),
      cwd: "src",
      createdAt: session.info.createdAt,
    });
    assert.equal(session.info.updatedAt, session.info.createdAt);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("in-memory session rebuilds messages and latest model", async () => {
  const session = memorySession();
  await session.appendModelChange(modelA);
  await session.appendMessage(user);
  await session.appendModelChange(modelB);
  await session.appendMessage(assistant);

  assert.deepEqual(session.buildContext(), {
    messages: [user, assistant],
    model: modelB,
  });
});

test("persistent session appends and reopens records", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir, input());
    await session.appendMessage(user);
    await session.appendMessage(assistant);
    await session.appendModelChange(modelB);

    const reopened = await Session.open(storageDir, session.id);
    assert.deepEqual(reopened.buildContext(), {
      messages: [user, assistant],
      model: modelB,
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("concurrent appends persist one ordered parent chain", async () => {
  const storageDir = await tempStorage();
  const followUp: AgentMessage = { role: "user", content: "follow up" };
  try {
    const session = await Session.create(storageDir, input());
    await session.appendMessage(user);
    await session.appendMessage(assistant);

    await Promise.all([
      session.appendMessage(followUp),
      session.appendModelChange(modelB),
    ]);

    const reopened = await Session.open(storageDir, session.id);
    assert.deepEqual(reopened.buildContext(), {
      messages: [user, assistant, followUp],
      model: modelB,
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects a headerless old Session", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(
      join(dir, "old.jsonl"),
      `${JSON.stringify({ type: "message", id: "x", parentId: null, message: user })}\n`,
    );
    await assert.rejects(Session.open(storageDir, "old"), isInvalidSession);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects missing, empty, malformed, and invalid-entry sessions", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  try {
    await mkdir(dir, { recursive: true });

    await assert.rejects(
      Session.open(storageDir, "missing"),
      (error: unknown) => error instanceof SessionError && error.code === "not_found",
    );

    await writeFile(join(dir, "empty.jsonl"), "");
    await assert.rejects(Session.open(storageDir, "empty"), isInvalidSession);

    await writeFile(join(dir, "bad-json.jsonl"), "{");
    await assert.rejects(Session.open(storageDir, "bad-json"), isInvalidSession);

    await writeFile(
      join(dir, "bad-header.jsonl"),
      `${JSON.stringify({ type: "session", version: 1, id: "other", projectId: "p", directory: ".", cwd: ".", title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    await assert.rejects(
      Session.open(storageDir, "bad-header"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );

    await writeFile(join(dir, "unsupported.jsonl"),
      `${JSON.stringify({ type: "session", version: 2, id: "unsupported", projectId: "p", directory: ".", cwd: ".", title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n`);
    await assert.rejects(Session.open(storageDir, "unsupported"), isInvalidSession);

    await writeFile(join(dir, "bad-record.jsonl"),
      `${JSON.stringify({ type: "session", version: 1, id: "bad-record", projectId: "p", directory: ".", cwd: ".", title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "unknown", id: "y", parentId: null, createdAt: "2026-01-01T00:00:00.000Z" })}\n`);
    await assert.rejects(
      Session.open(storageDir, "bad-record"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects session ids that can escape the sessions directory", async () => {
  const storageDir = await tempStorage();
  try {
    await assert.rejects(
      Session.open(storageDir, "../outside"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("failed append after external session-file deletion rolls back the new entry", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir, input());
    await session.appendMessage(user);
    await session.appendMessage(assistant);
    await rm(join(sessionsDir(storageDir), `${session.id}.jsonl`));

    await assert.rejects(
      session.appendModelChange(modelB),
      (error: unknown) => error instanceof SessionError && error.code === "storage",
    );
    assert.deepEqual(session.buildContext(), {
      messages: [user, assistant],
      model: null,
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("append rejects invalid runtime entries without changing the session", async () => {
  const invalidAppends: Array<{
    readonly append: (session: Session) => Promise<void>;
    readonly name: string;
  }> = [
    {
      name: "NaN assistant latency",
      append: (session) => session.appendMessage({ ...assistant, latencyMs: Number.NaN }),
    },
    {
      name: "infinite assistant token count",
      append: (session) => session.appendMessage({
        ...assistant,
        usage: { inputTokens: 1, outputTokens: Infinity, totalTokens: 2 },
      }),
    },
    {
      name: "non-string model ID",
      append: (session) => session.appendModelChange({
        provider: "test",
        model: null as unknown as string,
      }),
    },
  ];

  for (const { append, name } of invalidAppends) {
    await test(name, async () => {
      const session = memorySession();
      await assert.rejects(
        append(session),
        (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
      );
      assert.deepEqual(session.buildContext(), { messages: [], model: null });
    });
  }
});

test("a failed queued append does not block a later valid append", async () => {
  const session = memorySession();
  const failed = session.appendMessage({ ...assistant, latencyMs: Number.NaN });
  const succeeded = session.appendMessage(user);

  await assert.rejects(
    failed,
    (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
  );
  await succeeded;
  assert.deepEqual(session.buildContext(), { messages: [user], model: null });
});

test("open rejects duplicate IDs, missing parents, and multiple roots", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  const invalidTrees: Array<{
    readonly name: string;
    readonly entries: readonly object[];
  }> = [
    {
      name: "duplicate",
      entries: [
        { type: "message", id: "root", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", message: user },
        { type: "message", id: "root", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: assistant },
      ],
    },
    {
      name: "missing-parent",
      entries: [
        { type: "message", id: "child", parentId: "missing", createdAt: "2026-01-01T00:00:00.000Z", message: user },
      ],
    },
    {
      name: "multiple-roots",
      entries: [
        { type: "message", id: "first", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", message: user },
        { type: "message", id: "second", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", message: user },
      ],
    },
  ];
  try {
    await mkdir(dir, { recursive: true });
    for (const { name, entries } of invalidTrees) {
      await writeFile(
        join(dir, `${name}.jsonl`),
        `${JSON.stringify({ type: "session", version: 1, id: name, projectId: "p", directory: ".", cwd: ".", title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      await assert.rejects(
        Session.open(storageDir, name),
        (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
      );
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("buildContext returns a new messages array", async () => {
  const session = memorySession();
  await session.appendMessage(user);
  const first = session.buildContext();
  first.messages.push(assistant);
  assert.deepEqual(session.buildContext().messages, [user]);
});

test("buildContext follows the current leaf parent chain", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  const currentAssistant: AgentMessage = {
    ...assistant,
    content: [{ type: "text", text: "current branch" }],
  };
  try {
    await mkdir(dir, { recursive: true });
    const entries = [
      { type: "message", id: "root", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", message: user },
      { type: "message", id: "abandoned", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: assistant },
      { type: "message", id: "current", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: currentAssistant },
    ];
    await writeFile(
      join(dir, "branched.jsonl"),
      `${JSON.stringify({ type: "session", version: 1, id: "branched", projectId: "p", directory: ".", cwd: ".", title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const session = await Session.open(storageDir, "branched");
    assert.deepEqual(session.buildContext().messages, [user, currentAssistant]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("title records do not change the conversation tree", async () => {
  const session = memorySession();
  await session.setTitle("First title");
  await session.setTitle("Renamed");
  assert.equal(session.info.title, "Renamed");
  assert.deepEqual(session.buildContext().messages, []);
});

test("setTitleIfUnknown does not overwrite a queued manual title", async () => {
  const session = memorySession();
  await session.setTitle("Manual");
  assert.equal(await session.setTitleIfUnknown("Generated"), false);
  assert.equal(session.info.title, "Manual");
});

test("setTitleIfUnknown sets the first generated title", async () => {
  const session = memorySession();
  assert.equal(await session.setTitleIfUnknown("Generated"), true);
  assert.equal(session.info.title, "Generated");
});

test("title records roll back with the tree on failed persistence", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir, input());
    await session.appendMessage(user);
    await rm(join(sessionsDir(storageDir), `${session.id}.jsonl`));

    await assert.rejects(session.setTitle("new title"));
    assert.equal(session.info.title, "unknown");
    assert.deepEqual(session.buildContext().messages, [user]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("tool message details round-trip and non-JSON details are rejected", async () => {
  const session = memorySession();
  await session.appendMessage(detailedToolResult);
  assert.deepEqual(session.buildContext().messages.at(-1), detailedToolResult);

  const invalidDetails: AgentMessage = {
    role: "tool",
    toolCallId: "call-1",
    name: "todo_write",
    content: "Current tasks:\n1. [pending] test",
    details: { invalid: BigInt(1) },
    isError: false,
  };
  await assert.rejects(
    session.appendMessage(invalidDetails),
    /invalid/,
  );
});

test("JSONL session persists nested JSON-safe details", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir, input());
    const detailed: AgentMessage = {
      role: "tool",
      toolCallId: "call-9",
      name: "todo_write",
      content: "Current tasks:\n1. [pending] test",
      details: {
        todos: [{ content: "test", status: "pending" }],
        flags: [true, false, null],
        nested: { a: [1, 2] },
      },
      isError: false,
    };
    await session.appendMessage(user);
    await session.appendMessage(assistant);
    await session.appendMessage(detailed);

    const reopened = await Session.open(storageDir, session.id);
    assert.deepEqual(reopened.buildContext().messages.at(-1), detailed);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
