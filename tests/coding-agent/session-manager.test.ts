import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import type { ModelConfig } from "../../src/ai/types.js";
import { Session } from "../../src/agent/harness/session/session.js";
import { SessionManager } from "../../src/agent/harness/session/manager.js";
import { SessionError } from "../../src/agent/harness/session/types.js";

const model: ModelConfig = { provider: "test", model: "test" };
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

test("create ensures the sessions directory exists", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    assert.ok(sm.project.storageDir === storageDir);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("createSession returns a new session each call", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const s1 = await sm.createSession();
    const s2 = await sm.createSession();
    assert.notEqual(s1.id, s2.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("openSession opens a previously created session", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const created = await sm.createSession();
    await created.appendMessage(user);
    await created.appendMessage(assistant);

    const reopened = await sm.openSession(created.id);
    assert.deepEqual(reopened.buildContext().messages, [user, assistant]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("openSession rejects a missing session", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    await assert.rejects(
      sm.openSession("nonexistent"),
      (error: unknown) =>
        error instanceof SessionError && error.code === "not_found",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions returns empty when no sessions exist", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    assert.deepEqual(await sm.listSessions(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions returns most recent first", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const s1 = await sm.createSession();
    await s1.appendMessage(user);
    await s1.appendMessage(assistant);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const s2 = await sm.createSession();
    await s2.appendMessage(user);
    await s2.appendMessage(assistant);

    const list = await sm.listSessions();
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
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const session = await sm.createSession();
    await session.appendMessage(user);
    await session.appendMessage(assistant);

    // Write some noise files
    const sessionsDir = join(storageDir, "sessions");
    await writeFile(join(sessionsDir, "notes.txt"), "not a session");
    await writeFile(join(sessionsDir, ".hidden.jsonl"), "{}");

    const list = await sm.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0], session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("continueRecent opens the newest session", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const s1 = await sm.createSession();
    await s1.appendMessage({ role: "user", content: "old" });
    await s1.appendMessage(assistant);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const s2 = await sm.createSession();
    await s2.appendMessage({ role: "user", content: "new" });
    await s2.appendMessage(assistant);

    const latest = await sm.continueRecent();
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
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const session = await sm.continueRecent();
    assert.ok(session.id.length > 0);
    assert.deepEqual(session.buildContext().messages, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions returns empty when sessions directory does not exist", async () => {
  const storageDir = await tempStorage();
  try {
    // SessionManager.create() creates the directory, so we need to create
    // it then remove the sessions dir
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    await rm(join(storageDir, "sessions"), { recursive: true, force: true });
    assert.deepEqual(await sm.listSessions(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("listSessions filters out invalid session id filenames", async () => {
  const storageDir = await tempStorage();
  try {
    const sm = await SessionManager.create({
      workDir: process.cwd(),
      storageDir,
    });
    const session = await sm.createSession();
    await session.appendMessage(user);
    await session.appendMessage(assistant);

    const sessionsDir = join(storageDir, "sessions");
    await writeFile(join(sessionsDir, "not-valid$.jsonl"), "{}");
    await writeFile(join(sessionsDir, "../escape.jsonl"), "{}");

    const list = await sm.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0], session.id);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
