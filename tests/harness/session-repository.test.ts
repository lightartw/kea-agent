import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/core/agent/types.js";
import type { ModelConfig } from "../../src/core/ai/types.js";
import { SessionRepository } from "../../src/core/harness/session/repository.js";
import { SessionError } from "../../src/core/harness/session/types.js";
const user: AgentMessage = { role: "user", content: "hello" };
const followUp: AgentMessage = { role: "user", content: "follow up" };
const assistant: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "world" }],
  model: "test",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};
const modelB: ModelConfig = { provider: "test", model: "model-b" };

async function tempStorage(): Promise<string> {
  const path = join(tmpdir(), `kea-sr-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

// Backend paths are private to JsonlSessionStorage; tests define them locally.
const sessionsDir = (storageDir: string): string => join(storageDir, "sessions");
const sessionPath = (storageDir: string, id: string): string =>
  join(sessionsDir(storageDir), `${id}.jsonl`);

function repository(storageDir: string): SessionRepository {
  return new SessionRepository(storageDir);
}

async function createPersistedSession(storageDir: string): Promise<{
  repo: SessionRepository;
  sessionId: string;
}> {
  const repo = repository(storageDir);
  const session = await repo.create({ cwd: process.cwd() });
  await session.append({ type: "message", message: user });
  await session.append({ type: "message", message: assistant });
  return { repo, sessionId: session.metadata.id };
}

const isInvalidRecord = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "invalid_record";

const isInvalidSession = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "invalid_session";

const isNotFound = (error: unknown): boolean =>
  error instanceof SessionError && error.code === "not_found";

test("list returns empty when sessions directory does not exist", async () => {
  const storageDir = await tempStorage();
  try {
    assert.deepEqual(await repository(storageDir).list(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("create writes an unknown-title version-2 header and is immediately listed", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const session = await repo.create({ cwd: process.cwd() });
    const path = sessionPath(storageDir, session.metadata.id);
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      type: "session",
      version: 2,
      id: session.metadata.id,
      title: "unknown",
      cwd: resolve(process.cwd()),
      createdAt: session.metadata.createdAt,
    });
    assert.equal(session.headId, null);

    const listed = await repo.list();
    assert.deepEqual(listed.map((item) => item.id), [session.metadata.id]);
    assert.equal(listed[0]?.title, "unknown");
    assert.equal(listed[0]?.updatedAt, session.metadata.createdAt);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open restores nodes, title, cwd, selection, and head", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const created = await repo.create({ cwd: process.cwd() });
    await created.append({ type: "message", message: user });
    await created.setTitle("Restored title");
    await created.append({ type: "model_selection", selection: modelB });
    await created.append({ type: "message", message: assistant });

    const opened = await repo.open(created.metadata.id);
    assert.equal(opened.metadata.title, "Restored title");
    assert.equal(opened.metadata.cwd, resolve(process.cwd()));
    assert.deepEqual(opened.messages(), [user, assistant]);
    assert.deepEqual(opened.modelSelection(), modelB);
    assert.equal(opened.headId, created.headId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a later stored record controls metadata ordering", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const first = await repo.create({ cwd: process.cwd() });
    const second = await repo.create({ cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.setTitle("newest");
    assert.deepEqual(
      (await repo.list()).map((item) => item.id),
      [first.metadata.id, second.metadata.id],
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list orders by stored updatedAt descending, breaking ties by id", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const s1 = await createPersistedSession(storageDir);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const s2 = await createPersistedSession(storageDir);

    const list = await repo.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, s2.sessionId);
    assert.equal(list[1]?.id, s1.sessionId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list ignores non-jsonl files and hidden files", async () => {
  const storageDir = await tempStorage();
  try {
    const { sessionId } = await createPersistedSession(storageDir);

    const dir = sessionsDir(storageDir);
    await writeFile(join(dir, "notes.txt"), "not a session");
    await writeFile(join(dir, ".hidden.jsonl"), "{}");

    const list = await repository(storageDir).list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, sessionId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list filters out invalid session id filenames", async () => {
  const storageDir = await tempStorage();
  try {
    const { sessionId } = await createPersistedSession(storageDir);

    const dir = sessionsDir(storageDir);
    await writeFile(join(dir, "not-valid$.jsonl"), "{}");
    await writeFile(join(dir, "../escape.jsonl"), "{}");

    const list = await repository(storageDir).list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, sessionId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list rejects corrupt JSONL instead of silently omitting it", async () => {
  const storageDir = await tempStorage();
  try {
    await createPersistedSession(storageDir);
    const dir = sessionsDir(storageDir);
    await writeFile(join(dir, "corrupt.jsonl"), "this is not json");

    await assert.rejects(
      repository(storageDir).list(),
      (error: unknown) => error instanceof Error && error.message.includes("invalid"),
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects missing, empty, malformed, headerless, and version-1 sessions", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  try {
    await mkdir(dir, { recursive: true });
    const repo = repository(storageDir);

    await assert.rejects(
      repo.open("missing"),
      (error: unknown) => error instanceof SessionError && error.code === "not_found",
    );

    await writeFile(join(dir, "empty.jsonl"), "");
    await assert.rejects(repo.open("empty"), isInvalidSession);

    await writeFile(join(dir, "bad-json.jsonl"), "{");
    await assert.rejects(repo.open("bad-json"), isInvalidSession);

    await writeFile(
      join(dir, "headerless.jsonl"),
      `${JSON.stringify({ type: "message", id: "x", parentId: null, message: user })}\n`,
    );
    await assert.rejects(repo.open("headerless"), isInvalidSession);

    await writeFile(
      join(dir, "bad-header.jsonl"),
      `${JSON.stringify({ type: "session", version: 2, id: "other", cwd: process.cwd(), title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    await assert.rejects(
      repo.open("bad-header"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );

    await writeFile(
      join(dir, "version-1.jsonl"),
      `${JSON.stringify({ type: "session", version: 1, id: "version-1", projectId: "p", directory: ".", cwd: ".", title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    await assert.rejects(repo.open("version-1"), isInvalidSession);

    await writeFile(
      join(dir, "bad-row.jsonl"),
      `${JSON.stringify({ type: "session", version: 2, id: "bad-row", cwd: process.cwd(), title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "unknown", id: "y", parentId: null, createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    await assert.rejects(
      repo.open("bad-row"),
      isInvalidRecord,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects session ids that can escape the sessions directory", async () => {
  const storageDir = await tempStorage();
  try {
    await assert.rejects(
      repository(storageDir).open("../outside"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
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
        `${JSON.stringify({ type: "session", version: 2, id: name, cwd: process.cwd(), title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      await assert.rejects(
        repository(storageDir).open(name),
        isInvalidRecord,
      );
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("fork of the head copies the whole path and preserves node IDs", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const source = await repo.create({ cwd: process.cwd() });
    await source.append({ type: "message", message: user });
    await source.append({ type: "message", message: assistant });

    const fork = await repo.fork(source.metadata.id, source.headId);
    assert.notEqual(fork.metadata.id, source.metadata.id);
    assert.equal(fork.metadata.parentSessionId, source.metadata.id);
    assert.equal(fork.metadata.cwd, source.metadata.cwd);
    assert.equal(fork.metadata.title, "unknown");
    assert.deepEqual(fork.messages(), [user, assistant]);
    assert.deepEqual(
      fork.nodes.map((node) => node.id),
      source.nodes.map((node) => node.id),
    );

    const reopenedFork = await repo.open(fork.metadata.id);
    assert.deepEqual(reopenedFork.messages(), [user, assistant]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("fork of a selected node copies only the root-to-node path", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const source = await repo.create({ cwd: process.cwd() });
    await source.append({ type: "message", message: user });
    await source.append({ type: "message", message: assistant });
    const rootId = source.nodes[0]!.id;

    const rootFork = await repo.fork(source.metadata.id, rootId);
    assert.equal(rootFork.headId, rootId);
    assert.deepEqual(rootFork.messages(), [user]);
    assert.deepEqual(rootFork.nodes.map((node) => node.id), [rootId]);

    const emptyFork = await repo.fork(source.metadata.id, null);
    assert.equal(emptyFork.metadata.parentSessionId, source.metadata.id);
    assert.equal(emptyFork.headId, null);
    assert.deepEqual(emptyFork.messages(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("fork ignores abandoned branches and title rows", async () => {
  const storageDir = await tempStorage();
  const dir = sessionsDir(storageDir);
  const abandoned: AgentMessage = {
    ...assistant,
    content: [{ type: "text", text: "abandoned branch" }],
  };
  const current: AgentMessage = {
    ...assistant,
    content: [{ type: "text", text: "current branch" }],
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "branched.jsonl"),
      `${JSON.stringify({ type: "session", version: 2, id: "branched", cwd: process.cwd(), title: "x", createdAt: "2026-01-01T00:00:00.000Z" })}\n` +
        `${JSON.stringify({ type: "message", id: "root", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", message: user })}\n` +
        `${JSON.stringify({ type: "message", id: "abandoned", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: abandoned })}\n` +
        `${JSON.stringify({ type: "message", id: "current", parentId: "root", createdAt: "2026-01-01T00:00:00.000Z", message: current })}\n` +
        `${JSON.stringify({ type: "session_title", createdAt: "2026-01-01T00:00:00.000Z", title: "Source title" })}\n`,
    );

    const repo = repository(storageDir);
    const source = await repo.open("branched");
    const fork = await repo.fork(source.metadata.id, "current");
    assert.deepEqual(fork.messages(), [user, current]);
    assert.deepEqual(fork.nodes.map((node) => node.id), ["root", "current"]);
    assert.equal(fork.metadata.title, "unknown");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("new nodes append only to the fork, never the source", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const source = await repo.create({ cwd: process.cwd() });
    await source.append({ type: "message", message: user });
    await source.append({ type: "message", message: assistant });
    const fork = await repo.fork(source.metadata.id, source.headId);

    await fork.append({ type: "message", message: followUp });

    const reopenedSource = await repo.open(source.metadata.id);
    assert.deepEqual(reopenedSource.messages(), [user, assistant]);
    assert.deepEqual(fork.messages(), [user, assistant, followUp]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("fork of an unknown node is invalid", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const source = await repo.create({ cwd: process.cwd() });
    await source.append({ type: "message", message: user });

    await assert.rejects(
      repo.fork(source.metadata.id, "missing-node"),
      isNotFound,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("deleting a source Session does not affect its fork", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const source = await repo.create({ cwd: process.cwd() });
    await source.append({ type: "message", message: user });
    await source.append({ type: "message", message: assistant });
    const fork = await repo.fork(source.metadata.id, source.headId);

    await repo.delete(source.metadata.id);

    const reopened = await repo.open(fork.metadata.id);
    assert.deepEqual(reopened.messages(), [user, assistant]);
    assert.equal(reopened.metadata.parentSessionId, source.metadata.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("delete removes the Session from listing and open", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const session = await repo.create({ cwd: process.cwd() });
    await session.append({ type: "message", message: user });
    const id = session.metadata.id;

    await repo.delete(id);

    assert.deepEqual(await repo.list(), []);
    await assert.rejects(
      repo.open(id),
      (error: unknown) => error instanceof SessionError && error.code === "not_found",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("delete of a missing Session succeeds", async () => {
  const storageDir = await tempStorage();
  try {
    await repository(storageDir).delete("missing");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("delete rejects session ids that can escape the sessions directory", async () => {
  const storageDir = await tempStorage();
  try {
    await assert.rejects(
      repository(storageDir).delete("../outside"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
