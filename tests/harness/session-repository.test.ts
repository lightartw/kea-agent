import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import { Session, sessionsDir } from "../../src/harness/session/session.js";
import { SessionRepository } from "../../src/harness/session/repository.js";
import type { CreateSessionInput } from "../../src/harness/session/types.js";

const user: AgentMessage = { role: "user", content: "hello" };
const assistant: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "world" }],
  model: "test",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

async function tempStorage(): Promise<string> {
  const path = join(tmpdir(), `kea-sr-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

function repository(storageDir: string): SessionRepository {
  return new SessionRepository(storageDir);
}

function firstInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    projectId: "project_first",
    directory: process.cwd(),
    cwd: ".",
    ...overrides,
  };
}

function secondInput(): CreateSessionInput {
  return {
    projectId: "project_second",
    directory: process.cwd(),
    cwd: "src",
  };
}

async function createPersistedSession(storageDir: string): Promise<Session> {
  const session = await Session.create(storageDir, firstInput());
  await session.appendMessage(user);
  await session.appendMessage(assistant);
  return session;
}

test("list returns empty when sessions directory does not exist", async () => {
  const storageDir = await tempStorage();
  try {
    assert.deepEqual(await repository(storageDir).list(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("new empty Sessions are immediately listed", async () => {
  const storageDir = await tempStorage();
  try {
    const first = await repository(storageDir).create(firstInput());
    const listed = await repository(storageDir).list();
    assert.deepEqual(listed.map((item) => item.id), [first.id]);
    assert.equal(listed[0]?.title, "unknown");
    assert.equal(listed[0]?.updatedAt, first.info.createdAt);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a later stored record controls metadata ordering", async () => {
  const storageDir = await tempStorage();
  try {
    const repo = repository(storageDir);
    const first = await repo.create(firstInput());
    const second = await repo.create(secondInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.setTitle("newest");
    assert.deepEqual(
      (await repo.list()).map((item) => item.id),
      [first.id, second.id],
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
    assert.equal(list[0]?.id, s2.id);
    assert.equal(list[1]?.id, s1.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list ignores non-jsonl files and hidden files", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await createPersistedSession(storageDir);

    const dir = sessionsDir(storageDir);
    await writeFile(join(dir, "notes.txt"), "not a session");
    await writeFile(join(dir, ".hidden.jsonl"), "{}");

    const list = await repository(storageDir).list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list filters out invalid session id filenames", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await createPersistedSession(storageDir);

    const dir = sessionsDir(storageDir);
    await writeFile(join(dir, "not-valid$.jsonl"), "{}");
    await writeFile(join(dir, "../escape.jsonl"), "{}");

    const list = await repository(storageDir).list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, session.id);
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

test("open restores a persisted Session by id", async () => {
  const storageDir = await tempStorage();
  try {
    const created = await createPersistedSession(storageDir);
    const opened = await repository(storageDir).open(created.id);
    assert.equal(opened.id, created.id);
    assert.deepEqual(
      opened.buildContext().messages.map((message) => message.role),
      ["user", "assistant"],
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
