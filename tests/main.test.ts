import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentHarness, SessionMetadata } from "../src/core/harness/index.js";
import type { ModelConfig } from "../src/core/ai/index.js";
import type { Project } from "../src/coding-agent/index.js";

import { selectInitialHarness } from "../src/main.js";

const MODEL: ModelConfig = { provider: "test", model: "test" };

function makeHarness(id: string): AgentHarness {
  return {
    sessionId: `session-${id}`,
    model: MODEL,
    messages: [],
    isRunning: false,
    prompt: async () => {},
    switchModel: async () => {},
    abort: () => {},
    subscribe: () => () => {},
  } as unknown as AgentHarness;
}

function metadata(id: string): SessionMetadata {
  return {
    id,
    title: id,
    cwd: "/repo",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

function projectWithSessions(
  sessions: readonly SessionMetadata[],
): Project {
  const harnesses = new Map(
    sessions.map((entry) => [entry.id, makeHarness(entry.id)]),
  );
  const created = makeHarness("created");
  return {
    listSessions: async () => sessions,
    createHarness: async () => created,
    createHarnessFromSession: async (id: string) => {
      const harness = harnesses.get(id);
      if (harness === undefined) throw new Error(`unknown session: ${id}`);
      return harness;
    },
  } as unknown as Project;
}

test("continue opens the newest Session and falls back to create", async () => {
  const newest = metadata("newest");
  const older = metadata("older");

  const continuing = projectWithSessions([newest, older]);
  const restored = await continuing.createHarnessFromSession(newest.id);
  assert.equal(await selectInitialHarness(continuing, true), restored);

  const empty = projectWithSessions([]);
  const created = await empty.createHarness();
  assert.equal(await selectInitialHarness(empty, true), created);

  const fresh = projectWithSessions([newest]);
  const freshCreated = await fresh.createHarness();
  assert.equal(await selectInitialHarness(fresh, false), freshCreated);
});

test("importing main is silent and does not open readline", () => {
  const child = spawnSync(
    process.execPath,
    ["-e", "import('./dist/src/main.js')"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("run without user configuration falls back to init templates", () => {
  const home = mkdtempSync(join(tmpdir(), "kea-main-"));
  try {
    const run = (): SpawnSyncReturns<string> =>
      spawnSync(
        process.execPath,
        ["dist/src/main.js"],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, USERPROFILE: home },
          encoding: "utf8",
        },
      );

    const first = run();
    assert.match(first.stdout, /config\.json: created/);
    assert.match(first.stdout, /auth\.json: created/);
    assert.equal(existsSync(join(home, ".kea", "config.json")), true);
    assert.equal(existsSync(join(home, ".kea", "auth.json")), true);
    // Credentials still have to be filled in before the run can proceed.
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stderr, /must be non-empty/);

    // Existing files are never re-created or reported again.
    const second = run();
    assert.doesNotMatch(second.stdout, /created/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
