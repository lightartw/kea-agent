import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import { Session } from "../../src/harness/session/session.js";
import { SessionRepository } from "../../src/harness/session/repository.js";

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

async function createPersistedSession(storageDir: string): Promise<Session> {
  const session = await Session.create(storageDir);
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

test("list returns empty when the sessions directory is empty", async () => {
  const storageDir = await tempStorage();
  try {
    await mkdir(join(storageDir, "sessions"), { recursive: true });
    assert.deepEqual(await repository(storageDir).list(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list returns most recent first", async () => {
  const storageDir = await tempStorage();
  try {
    const s1 = await createPersistedSession(storageDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const s2 = await createPersistedSession(storageDir);

    const list = await repository(storageDir).list();
    assert.equal(list.length, 2);
    assert.equal(list[0], s2.id);
    assert.equal(list[1], s1.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list ignores non-jsonl files and hidden files", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await createPersistedSession(storageDir);

    const sessionsDir = join(storageDir, "sessions");
    await writeFile(join(sessionsDir, "notes.txt"), "not a session");
    await writeFile(join(sessionsDir, ".hidden.jsonl"), "{}");

    const list = await repository(storageDir).list();
    assert.equal(list.length, 1);
    assert.equal(list[0], session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("list filters out invalid session id filenames", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await createPersistedSession(storageDir);

    const sessionsDir = join(storageDir, "sessions");
    await writeFile(join(sessionsDir, "not-valid$.jsonl"), "{}");
    await writeFile(join(sessionsDir, "../escape.jsonl"), "{}");

    const list = await repository(storageDir).list();
    assert.equal(list.length, 1);
    assert.equal(list[0], session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("create returns a Session owned by this repository", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await repository(storageDir).create();
    assert.ok(session.id.length > 0);
    assert.deepEqual(session.buildContext().messages, []);
    assert.deepEqual(await repository(storageDir).list(), []);
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
