import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import { Session } from "../../src/harness/session/session.js";
import { SessionManager } from "../../src/harness/session/manager.js";

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
  const path = join(tmpdir(), `kea-sm-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

function manager(storageDir: string): SessionManager {
  return new SessionManager({ workDir: process.cwd(), storageDir });
}

async function createPersistedSession(storageDir: string): Promise<Session> {
  const session = await Session.create(storageDir);
  await session.appendMessage(user);
  await session.appendMessage(assistant);
  return session;
}

test("listSessions returns empty when sessions directory does not exist", async () => {
  const storageDir = await tempStorage();
  try {
    assert.deepEqual(await manager(storageDir).listSessions(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions returns empty when the sessions directory is empty", async () => {
  const storageDir = await tempStorage();
  try {
    await mkdir(join(storageDir, "sessions"), { recursive: true });
    assert.deepEqual(await manager(storageDir).listSessions(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions returns most recent first", async () => {
  const storageDir = await tempStorage();
  try {
    const s1 = await createPersistedSession(storageDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const s2 = await createPersistedSession(storageDir);

    const list = await manager(storageDir).listSessions();
    assert.equal(list.length, 2);
    assert.equal(list[0], s2.id);
    assert.equal(list[1], s1.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions ignores non-jsonl files and hidden files", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await createPersistedSession(storageDir);

    const sessionsDir = join(storageDir, "sessions");
    await writeFile(join(sessionsDir, "notes.txt"), "not a session");
    await writeFile(join(sessionsDir, ".hidden.jsonl"), "{}");

    const list = await manager(storageDir).listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0], session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions filters out invalid session id filenames", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await createPersistedSession(storageDir);

    const sessionsDir = join(storageDir, "sessions");
    await writeFile(join(sessionsDir, "not-valid$.jsonl"), "{}");
    await writeFile(join(sessionsDir, "../escape.jsonl"), "{}");

    const list = await manager(storageDir).listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0], session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("continueRecent opens the newest session", async () => {
  const storageDir = await tempStorage();
  try {
    const s1 = await Session.create(storageDir);
    await s1.appendMessage({ role: "user", content: "old" });
    await s1.appendMessage(assistant);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const s2 = await Session.create(storageDir);
    await s2.appendMessage({ role: "user", content: "new" });
    await s2.appendMessage(assistant);

    const latest = await manager(storageDir).continueRecent();
    assert.equal(latest.id, s2.id);
    assert.deepEqual(
      latest.buildContext().messages.map((m) =>
        m.role === "user" ? (m as { role: "user"; content: string }).content : m.role,
      ),
      ["new", "assistant"],
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("continueRecent creates a new session when none exist", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await manager(storageDir).continueRecent();
    assert.ok(session.id.length > 0);
    assert.deepEqual(session.buildContext().messages, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
