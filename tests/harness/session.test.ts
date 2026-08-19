import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/core/harness/types.js";
import type { ModelConfig } from "../../src/core/ai/types.js";
import { Session } from "../../src/core/harness/session/session.js";
import { SessionRepository } from "../../src/core/harness/session/repository.js";
import type { SessionStorage } from "../../src/core/harness/session/types.js";
import { SessionError } from "../../src/core/harness/session/types.js";
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
  await mkdirSync(path);
  return path;
}

// Backend paths are private to JsonlSessionStorage; tests define them locally.
const sessionsDir = (storageDir: string): string => join(storageDir, "sessions");
const sessionPath = (storageDir: string, id: string): string =>
  join(sessionsDir(storageDir), `${id}.jsonl`);

function memorySession(): Session {
  return Session.inMemory({ cwd: process.cwd() });
}

function persistentSession(storageDir: string): Promise<Session> {
  return new SessionRepository(storageDir).create({ cwd: process.cwd() });
}

const isInvalidRecord = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "invalid_record";

const isNotFound = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "not_found";

test("append generates node identity and common fields", async () => {
  const session = memorySession();
  const id = await session.append({ type: "message", message: user });
  assert.equal(id, session.headId);

  const node = session.nodes[0];
  assert.ok(node);
  assert.equal(node.type, "message");
  assert.equal(node.id, id);
  assert.equal(node.parentId, null);
  assert.ok(!Number.isNaN(Date.parse(node.createdAt)));
  assert.deepEqual(node.message, user);
});

test("in-memory session projects messages and latest model", async () => {
  const session = memorySession();
  await session.append({ type: "model_selection", selection: modelA });
  await session.append({ type: "message", message: user });
  await session.append({ type: "model_selection", selection: modelB });
  await session.append({ type: "message", message: assistant });

  assert.deepEqual(session.messages(), [user, assistant]);
  assert.deepEqual(session.modelSelection(), modelB);
  assert.deepEqual(session.nodes.map((node) => node.type), [
    "model_selection", "message", "model_selection", "message",
  ]);
});

test("persistent session appends and reopens nodes", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await persistentSession(storageDir);
    await session.append({ type: "message", message: user });
    await session.append({ type: "message", message: assistant });
    await session.append({ type: "model_selection", selection: modelB });

    const reopened = await new SessionRepository(storageDir).open(session.id);
    assert.deepEqual(reopened.messages(), [user, assistant]);
    assert.deepEqual(reopened.modelSelection(), modelB);
    assert.equal(reopened.headId, session.headId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("failed append after external session-file deletion rolls back node and head", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await persistentSession(storageDir);
    await session.append({ type: "message", message: user });
    await session.append({ type: "message", message: assistant });
    await rm(sessionPath(storageDir, session.id));

    await assert.rejects(
      session.append({ type: "model_selection", selection: modelB }),
      (error: unknown) => error instanceof SessionError && error.code === "storage",
    );
    assert.deepEqual(session.messages(), [user, assistant]);
    assert.equal(session.modelSelection(), null);
    assert.equal(session.headId, session.nodes.at(-1)?.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("append rejects invalid runtime entries without changing the session", async () => {
  const invalidAppends: Array<{
    readonly append: (session: Session) => Promise<unknown>;
    readonly name: string;
  }> = [
    {
      name: "NaN assistant latency",
      append: (session) => session.append({
        type: "message",
        message: { ...assistant, latencyMs: Number.NaN },
      }),
    },
    {
      name: "infinite assistant token count",
      append: (session) => session.append({
        type: "message",
        message: {
          ...assistant,
          usage: { inputTokens: 1, outputTokens: Infinity, totalTokens: 2 },
        },
      }),
    },
    {
      name: "non-string model ID",
      append: (session) => session.append({
        type: "model_selection",
        selection: { provider: "test", model: null as unknown as string },
      }),
    },
  ];

  for (const { append, name } of invalidAppends) {
    await test(name, async () => {
      const session = memorySession();
      await assert.rejects(
        append(session),
        isInvalidRecord,
      );
      assert.deepEqual(session.messages(), []);
      assert.equal(session.modelSelection(), null);
      assert.equal(session.headId, null);
      assert.deepEqual(session.nodes, []);
    });
  }
});

test("messages returns a fresh array", async () => {
  const session = memorySession();
  await session.append({ type: "message", message: user });
  const first = session.messages();
  assert.notEqual(session.messages(), first);
  assert.deepEqual(session.messages(), [user]);
});

test("path follows the head parent chain and skips abandoned nodes", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  const currentAssistant: AgentMessage = {
    ...assistant,
    content: [{ type: "text", text: "current branch" }],
  };
  try {
    await mkdirSync(dir, { recursive: true });
    const entries = [
      { type: "message", id: "root", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", message: user },
      { type: "message", id: "abandoned", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: assistant },
      { type: "message", id: "current", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: currentAssistant },
    ];
    await writeFileSync(
      join(dir, "branched.jsonl"),
      `${JSON.stringify({ type: "session", version: 2, id: "branched", cwd: process.cwd(), title: "x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const session = await new SessionRepository(storageDir).open("branched");
    assert.equal(session.headId, "current");
    assert.deepEqual(session.messages(), [user, currentAssistant]);
    assert.deepEqual(session.path().map((node) => node.id), ["root", "current"]);
    assert.deepEqual(session.path("root").map((node) => node.id), ["root"]);
    assert.deepEqual(session.path(null), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("path rejects unknown node IDs", async () => {
  const session = memorySession();
  await session.append({ type: "message", message: user });
  assert.throws(() => session.path("missing"), isNotFound);
});

test("modelSelection scans the selected path newest first", async () => {
  const session = memorySession();
  const messageId = await session.append({ type: "message", message: user });
  const selectionId = await session.append({ type: "model_selection", selection: modelA });
  await session.append({ type: "message", message: assistant });

  assert.deepEqual(session.modelSelection(), modelA);
  assert.deepEqual(session.modelSelection(selectionId), modelA);
  assert.equal(session.modelSelection(messageId), null);
  assert.equal(session.modelSelection(null), null);
});

test("nodes excludes title rows and title changes never touch the tree", async () => {
  const session = memorySession();
  await session.setTitle("First title");
  await session.append({ type: "message", message: user });
  await session.append({ type: "model_selection", selection: modelA });
  await session.setTitle("Renamed");

  assert.equal(session.metadata.title, "Renamed");
  assert.deepEqual(session.nodes.map((node) => node.type), ["message", "model_selection"]);
  assert.deepEqual(session.messages(), [user]);
  assert.equal(session.headId, session.nodes.at(-1)?.id);
});

test("title rows roll back on failed persistence", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await persistentSession(storageDir);
    await session.append({ type: "message", message: user });
    await rm(sessionPath(storageDir, session.id));

    await assert.rejects(session.setTitle("new title"));
    assert.equal(session.metadata.title, "unknown");
    assert.deepEqual(session.messages(), [user]);
    assert.equal(session.headId, session.nodes.at(-1)?.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("inMemory resolves cwd to an absolute path", () => {
  const session = Session.inMemory({ cwd: "." });
  assert.equal(session.metadata.cwd, resolve("."));
});

test("tool message details round-trip and non-JSON details are rejected", async () => {
  const session = memorySession();
  await session.append({ type: "message", message: detailedToolResult });
  assert.deepEqual(session.messages().at(-1), detailedToolResult);

  const invalidDetails: AgentMessage = {
    role: "tool",
    toolCallId: "call-1",
    name: "todo_write",
    content: "Current tasks:\n1. [pending] test",
    details: { invalid: BigInt(1) },
    isError: false,
  };
  await assert.rejects(
    session.append({ type: "message", message: invalidDetails }),
    /invalid/,
  );
});

test("JSONL session persists nested JSON-safe details", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await persistentSession(storageDir);
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
    await session.append({ type: "message", message: user });
    await session.append({ type: "message", message: assistant });
    await session.append({ type: "message", message: detailed });

    const reopened = await new SessionRepository(storageDir).open(session.id);
    assert.deepEqual(reopened.messages().at(-1), detailed);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("append publishes nothing when storage rejects", async () => {
  const failure = new Error("storage rejected append");
  const storage: SessionStorage = {
    create: async () => {},
    load: async () => {
      throw new Error("unused load");
    },
    list: async () => [],
    append: async () => {
      throw failure;
    },
    setTitle: async () => {},
    delete: async () => {},
  };
  const session = Session.fromStorage(
    {
      metadata: {
        id: "s1",
        title: "unknown",
        cwd: process.cwd(),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      nodes: [],
    },
    storage,
  );

  await assert.rejects(
    session.append({ type: "message", message: user }),
    (error: unknown) => error === failure,
  );
  assert.equal(session.headId, null);
  assert.deepEqual(session.nodes, []);
  assert.deepEqual(session.messages(), []);
});
