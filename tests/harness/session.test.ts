import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/core/agent/types.js";
import type { ModelConfig } from "../../src/core/ai/types.js";
import { Session, sessionsDir } from "../../src/core/harness/session/session.js";
import { SessionRepository } from "../../src/core/harness/session/repository.js";
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

function memorySession(): Session {
  return Session.inMemory({ cwd: process.cwd() });
}

function persistentSession(storageDir: string): Promise<Session> {
  return new SessionRepository(storageDir).create({ cwd: process.cwd() });
}

const isInvalidEntry = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "invalid_entry";

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

test("concurrent appends persist one ordered parent chain", async () => {
  const storageDir = await tempStorage();
  const followUp: AgentMessage = { role: "user", content: "follow up" };
  try {
    const session = await persistentSession(storageDir);
    await session.append({ type: "message", message: user });
    await session.append({ type: "message", message: assistant });

    await Promise.all([
      session.append({ type: "message", message: followUp }),
      session.append({ type: "model_selection", selection: modelB }),
    ]);

    const reopened = await new SessionRepository(storageDir).open(session.id);
    assert.deepEqual(reopened.messages(), [user, assistant, followUp]);
    assert.deepEqual(reopened.modelSelection(), modelB);
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
    await rm(join(sessionsDir(storageDir), `${session.id}.jsonl`));

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
        (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
      );
      assert.deepEqual(session.messages(), []);
      assert.equal(session.modelSelection(), null);
      assert.equal(session.headId, null);
      assert.deepEqual(session.nodes, []);
    });
  }
});

test("a failed queued append does not block a later valid append", async () => {
  const session = memorySession();
  const failed = session.append({
    type: "message",
    message: { ...assistant, latencyMs: Number.NaN },
  });
  const succeeded = session.append({ type: "message", message: user });

  await assert.rejects(
    failed,
    (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
  );
  await succeeded;
  assert.deepEqual(session.messages(), [user]);
  assert.equal(session.modelSelection(), null);
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
      `${JSON.stringify({ type: "session", version: 2, id: "branched", cwd: process.cwd(), title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
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
  assert.throws(() => session.path("missing"), isInvalidEntry);
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

test("setTitleIfUnknown does not overwrite a queued manual title", async () => {
  const session = memorySession();
  await session.setTitle("Manual");
  assert.equal(await session.setTitleIfUnknown("Generated"), false);
  assert.equal(session.metadata.title, "Manual");
});

test("setTitleIfUnknown sets the first generated title", async () => {
  const session = memorySession();
  assert.equal(await session.setTitleIfUnknown("Generated"), true);
  assert.equal(session.metadata.title, "Generated");
});

test("title rows roll back on failed persistence", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await persistentSession(storageDir);
    await session.append({ type: "message", message: user });
    await rm(join(sessionsDir(storageDir), `${session.id}.jsonl`));

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
