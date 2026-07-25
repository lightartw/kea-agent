import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import type { ModelConfig } from "../../src/ai/types.js";
import { Session } from "../../src/harness/session/session.js";
import { SessionError } from "../../src/harness/session/types.js";

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

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test("in-memory session rebuilds messages and latest model", async () => {
  const session = Session.inMemory();
  await session.appendModelChange(modelA);
  await session.appendMessage(user);
  await session.appendModelChange(modelB);
  await session.appendMessage(assistant);

  assert.deepEqual(session.buildContext(), {
    messages: [user, assistant],
    model: modelB,
  });
});

test("persistent session delays file creation until first assistant", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir);
    const path = join(storageDir, "sessions", `${session.id}.jsonl`);
    await session.appendMessage(user);
    await assertMissing(path);

    await session.appendMessage(assistant);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).type), [
      "message",
      "message",
    ]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("persistent session appends entries after first assistant", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir);
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

test("open rejects missing, empty, malformed, and invalid-entry sessions", async () => {
  const storageDir = await tempStorage();
  const sessionsDir = join(storageDir, "sessions");
  try {
    await mkdir(sessionsDir, { recursive: true });

    await assert.rejects(
      Session.open(storageDir, "missing"),
      (error: unknown) => error instanceof SessionError && error.code === "not_found",
    );

    await writeFile(join(sessionsDir, "empty.jsonl"), "");
    await assert.rejects(
      Session.open(storageDir, "empty"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );

    await writeFile(join(sessionsDir, "bad-json.jsonl"), "{");
    await assert.rejects(
      Session.open(storageDir, "bad-json"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );

    await writeFile(
      join(sessionsDir, "bad-entry.jsonl"),
      `${JSON.stringify({ type: "unknown", id: "x", parentId: null })}\n`,
    );
    await assert.rejects(
      Session.open(storageDir, "bad-entry"),
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
      (error: unknown) =>
        error instanceof SessionError && error.code === "invalid_session",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("failed first flush rolls back the assistant entry and leaf", async () => {
  const storageDir = await tempStorage();
  const session = await Session.create(storageDir);
  await session.appendMessage(user);
  await rm(join(storageDir, "sessions"), { recursive: true, force: true });

  await assert.rejects(session.appendMessage(assistant));
  assert.deepEqual(session.buildContext().messages, [user]);

  await rm(storageDir, { recursive: true, force: true });
});

test("failed append after external session-file deletion rolls back the new entry", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir);
    const path = join(storageDir, "sessions", `${session.id}.jsonl`);
    await session.appendMessage(user);
    await session.appendMessage(assistant);
    await rm(path);

    await assert.rejects(
      session.appendModelChange(modelB),
      (error: unknown) => error instanceof SessionError && error.code === "storage",
    );
    await assertMissing(path);
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
      const session = Session.inMemory();
      await assert.rejects(
        append(session),
        (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
      );
      assert.deepEqual(session.buildContext(), { messages: [], model: null });
    });
  }
});

test("open rejects duplicate IDs, missing parents, and multiple roots", async () => {
  const storageDir = await tempStorage();
  const sessionsDir = join(storageDir, "sessions");
  const invalidTrees: Array<{
    readonly name: string;
    readonly entries: readonly object[];
  }> = [
    {
      name: "duplicate",
      entries: [
        { type: "message", id: "root", parentId: null, message: user },
        { type: "message", id: "root", parentId: "root", message: assistant },
      ],
    },
    {
      name: "missing-parent",
      entries: [
        { type: "message", id: "child", parentId: "missing", message: user },
      ],
    },
    {
      name: "multiple-roots",
      entries: [
        { type: "message", id: "first", parentId: null, message: user },
        { type: "message", id: "second", parentId: null, message: user },
      ],
    },
  ];
  try {
    await mkdir(sessionsDir, { recursive: true });
    for (const { name, entries } of invalidTrees) {
      await writeFile(
        join(sessionsDir, `${name}.jsonl`),
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
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
  const session = Session.inMemory();
  await session.appendMessage(user);
  const first = session.buildContext();
  first.messages.push(assistant);
  assert.deepEqual(session.buildContext().messages, [user]);
});

test("buildContext follows the current leaf parent chain", async () => {
  const storageDir = await tempStorage();
  const sessionsDir = join(storageDir, "sessions");
  const currentAssistant: AgentMessage = {
    ...assistant,
    content: [{ type: "text", text: "current branch" }],
  };
  try {
    await mkdir(sessionsDir, { recursive: true });
    const entries = [
      { type: "message", id: "root", parentId: null, message: user },
      {
        type: "message",
        id: "abandoned",
        parentId: "root",
        message: assistant,
      },
      {
        type: "message",
        id: "current",
        parentId: "root",
        message: currentAssistant,
      },
    ];
    await writeFile(
      join(sessionsDir, "branched.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const session = await Session.open(storageDir, "branched");
    assert.deepEqual(session.buildContext().messages, [user, currentAssistant]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
