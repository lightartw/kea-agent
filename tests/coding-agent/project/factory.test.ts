import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { AssistantMessage, ModelConfig } from "../../../src/core/ai/types.js";
import { openOrCreateProject } from "../../../src/coding-agent/factory.js";
import type { Project } from "../../../src/coding-agent/project/project.js";
import type { UserInteraction } from "../../../src/coding-agent/interaction/interactions.js";
import { runtimeFromStream, type TestStream } from "../../fixtures/model-runtime.js";

const execFileAsync = promisify(execFile);

const modelConfig: ModelConfig = { provider: "test", model: "model-a" };

const testInteractions: UserInteraction = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
};

const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

const simpleStream: TestStream = async function* () {
  yield { type: "done", message: assistant };
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-open-"));
}

async function gitInit(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
}

function uuid(index: number): string {
  return `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, "0")}`;
}

/** Stream that records every system prompt it receives. */
function recordingStream(prompts: string[]): TestStream {
  return async function* (_model, context) {
    prompts.push(context.systemPrompt ?? "");
    yield { type: "done", message: assistant };
  };
}

async function persistDocument(
  keaHome: string,
  projectId: string,
  document: unknown,
): Promise<void> {
  await mkdir(join(keaHome, "projects", projectId), { recursive: true });
  await writeFile(
    join(keaHome, "projects", projectId, "project.json"),
    JSON.stringify(document),
  );
}

async function openProject(
  keaHome: string,
  projectDirectory: string,
  overrides: Partial<Parameters<typeof openOrCreateProject>[0]> = {},
): Promise<Project> {
  return openOrCreateProject({
    keaHome,
    projectDirectory,
    runtime: runtimeFromStream(simpleStream),
    modelConfig,
    models: [modelConfig],
    interaction: testInteractions,
    maxTurns: 20,
    toolTimeoutSeconds: 120,
    ...overrides,
  });
}

test("an existing canonical directory becomes the Project directory", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await openProject(keaHome, await realpath(dir));
    assert.equal(project.info.directory, resolve(dir));
    assert.equal(project.info.name, basename(dir));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a filesystem root gets a non-empty Project name", async () => {
  const keaHome = await tempDir();
  try {
    const root = parse(process.cwd()).root;
    const project = await openProject(keaHome, await realpath(root));
    assert.equal(project.info.directory, resolve(root));
    assert.notEqual(project.info.name, "");
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

test("the same directory reuses one Project ID while parent and child directories stay distinct", async () => {
  const keaHome = await tempDir();
  const parent = await tempDir();
  try {
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });

    const first = await openProject(keaHome, await realpath(parent));
    const second = await openProject(keaHome, await realpath(parent));
    assert.equal(second.info.id, first.info.id);

    const childProject = await openProject(keaHome, await realpath(child));
    assert.notEqual(childProject.info.id, first.info.id);
    assert.equal(childProject.info.directory, resolve(child));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("first open persists Project data and constructs the SessionRepository below dataDirectory", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await openProject(keaHome, await realpath(dir));
    const projectId = project.info.id;
    const projectDirOnDisk = join(keaHome, "projects", projectId);
    const raw = JSON.parse(
      await readFile(join(projectDirOnDisk, "project.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(raw.version, 1);
    assert.equal(raw.id, projectId);
    assert.equal(raw.name, basename(dir));
    assert.equal(raw.directory, resolve(dir));
    assert.equal(raw.createdAt, raw.updatedAt);
    assert.ok(typeof raw.createdAt === "string");

    const harness = await project.createHarness();
    const sessionsDir = join(projectDirOnDisk, "sessions");
    assert.deepEqual(await readdir(sessionsDir), [`${harness.sessionId}.jsonl`]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("every startup followed by createHarness creates a new Session ID even with history", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const first = await openProject(keaHome, await realpath(dir));
    const firstHarness = await first.createHarness({ cwd: dir });

    const second = await openProject(keaHome, await realpath(dir));
    const secondHarness = await second.createHarness({ cwd: dir });
    assert.notEqual(secondHarness.sessionId, firstHarness.sessionId);
    assert.equal((await second.listSessions()).length, 2);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("relative, missing, file, and non-canonical projectDirectory values reject", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    await assert.rejects(
      openProject(keaHome, "relative/path"),
      /must be absolute and normalized/i,
    );

    await assert.rejects(
      openProject(keaHome, join(dir, "missing")),
      /does not exist/i,
    );

    const file = join(dir, "file.txt");
    await writeFile(file, "not a directory");
    await assert.rejects(
      openProject(keaHome, file),
      /is not a directory/i,
    );

    const real = join(dir, "real");
    const link = join(dir, "link");
    await mkdir(real, { recursive: true });
    try {
      await symlink(real, link, "junction");
    } catch {
      return; // Platform forbids directory links; the canonical check is covered elsewhere.
    }
    await assert.rejects(
      openProject(keaHome, link),
      /must be canonical/i,
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt, unsupported, unreadable, and duplicate records reject without creating another Project", async () => {
  const dir = await tempDir();
  try {
    const directory = resolve(dir);

    // Corrupt JSON.
    const corruptHome = await tempDir();
    try {
      await mkdir(join(corruptHome, "projects", uuid(1)), { recursive: true });
      await writeFile(join(corruptHome, "projects", uuid(1), "project.json"), "not json");
      await assert.rejects(
        openProject(corruptHome, directory),
        /invalid JSON/i,
      );
      assert.deepEqual(await readdir(join(corruptHome, "projects")), [uuid(1)]);
    } finally {
      await rm(corruptHome, { recursive: true, force: true });
    }

    // Unsupported version.
    const versionHome = await tempDir();
    try {
      await persistDocument(versionHome, uuid(1), {
        version: 2,
        id: uuid(1),
        name: "example",
        directory,
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      });
      await assert.rejects(
        openProject(versionHome, directory),
        /version/i,
      );
      assert.deepEqual(await readdir(join(versionHome, "projects")), [uuid(1)]);
    } finally {
      await rm(versionHome, { recursive: true, force: true });
    }

    // Unreadable record (project.json is a directory).
    const unreadableHome = await tempDir();
    try {
      await mkdir(join(unreadableHome, "projects", uuid(1), "project.json"), { recursive: true });
      await assert.rejects(
        openProject(unreadableHome, directory),
        /read/i,
      );
      assert.deepEqual(await readdir(join(unreadableHome, "projects")), [uuid(1)]);
    } finally {
      await rm(unreadableHome, { recursive: true, force: true });
    }

    // Duplicate ownership.
    const duplicateHome = await tempDir();
    try {
      const document = {
        version: 1,
        id: uuid(1),
        name: "example",
        directory,
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      };
      await persistDocument(duplicateHome, uuid(1), document);
      await persistDocument(duplicateHome, uuid(2), { ...document, id: uuid(2) });
      await assert.rejects(
        openProject(duplicateHome, directory),
        /more than one/i,
      );
      assert.deepEqual(
        (await readdir(join(duplicateHome, "projects"))).sort(),
        [uuid(1), uuid(2)],
      );
    } finally {
      await rm(duplicateHome, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

