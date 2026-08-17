import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { AssistantMessage, ModelConfig } from "../../../src/core/ai/types.js";
import {
  openOrCreateProject,
  setGitToplevelExecutorForTests,
} from "../../../src/coding-agent/project/open.js";
import { runtimeFromStream, type TestStream } from "../../fixtures/model-runtime.js";

const execFileAsync = promisify(execFile);

const modelConfig: ModelConfig = { provider: "test", model: "model-a" };

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

test("omitted cwd uses process.cwd()", async () => {
  const keaHome = await tempDir();
  try {
    const project = await openOrCreateProject({ keaHome, runtime: runtimeFromStream(simpleStream), modelConfig });
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
    });
    assert.equal(project.info.directory, resolve(stdout.trim()));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

test("a non-Git cwd becomes the canonical Project directory", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const project = await openOrCreateProject({
      keaHome,
      cwd: dir,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    assert.equal(project.info.directory, resolve(dir));
    assert.equal(project.info.name, basename(dir));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cwd below a Git work-tree resolves to the work-tree root while the Session keeps the startup cwd", async () => {
  const keaHome = await tempDir();
  const repo = await tempDir();
  try {
    await gitInit(repo);
    const sub = join(repo, "packages", "web");
    await mkdir(sub, { recursive: true });

    const prompts: string[] = [];
    const project = await openOrCreateProject({
      keaHome,
      cwd: sub,
      runtime: runtimeFromStream(recordingStream(prompts)),
      modelConfig,
    });
    assert.equal(project.info.directory, resolve(repo));

    const harness = await project.createHarness({ cwd: sub });
    await harness.prompt("hello");
    assert.ok(prompts[0]?.includes(resolve(sub)));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("two startups in the same Git work-tree reuse one stable Project ID", async () => {
  const keaHome = await tempDir();
  const repo = await tempDir();
  try {
    await gitInit(repo);
    const sub = join(repo, "src");
    await mkdir(sub, { recursive: true });

    const first = await openOrCreateProject({
      keaHome,
      cwd: repo,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    const second = await openOrCreateProject({
      keaHome,
      cwd: sub,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    assert.equal(second.info.id, first.info.id);
    assert.equal(second.info.directory, resolve(repo));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("the same non-Git cwd reuses one Project ID while parent and child cwds stay distinct", async () => {
  const keaHome = await tempDir();
  const parent = await tempDir();
  try {
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });

    const first = await openOrCreateProject({
      keaHome,
      cwd: parent,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    const second = await openOrCreateProject({
      keaHome,
      cwd: parent,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    assert.equal(second.info.id, first.info.id);

    const childProject = await openOrCreateProject({
      keaHome,
      cwd: child,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
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
    const project = await openOrCreateProject({
      keaHome,
      cwd: dir,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
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
    const first = await openOrCreateProject({
      keaHome,
      cwd: dir,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    const firstHarness = await first.createHarness({ cwd: dir });

    const second = await openOrCreateProject({
      keaHome,
      cwd: dir,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    const secondHarness = await second.createHarness({ cwd: dir });
    assert.notEqual(secondHarness.sessionId, firstHarness.sessionId);
    assert.equal((await second.listSessions()).length, 2);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing cwd and cwd that is a file reject", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    await assert.rejects(
      openOrCreateProject({
        keaHome,
        cwd: join(dir, "missing"),
        runtime: runtimeFromStream(simpleStream),
        modelConfig,
      }),
      /does not exist/i,
    );
    const file = join(dir, "file.txt");
    await writeFile(file, "not a directory");
    await assert.rejects(
      openOrCreateProject({
        keaHome,
        cwd: file,
        runtime: runtimeFromStream(simpleStream),
        modelConfig,
      }),
      /is not a directory/i,
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit not-a-repository result falls back to cwd while other Git failures reject", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    setGitToplevelExecutorForTests(async () => ({ kind: "not_a_repository" }));
    const project = await openOrCreateProject({
      keaHome,
      cwd: dir,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    assert.equal(project.info.directory, resolve(dir));

    setGitToplevelExecutorForTests(async () => {
      throw new Error("git is not installed");
    });
    await assert.rejects(
      openOrCreateProject({
        keaHome,
        cwd: dir,
        runtime: runtimeFromStream(simpleStream),
        modelConfig,
      }),
      /git is not installed/,
    );
  } finally {
    setGitToplevelExecutorForTests(null);
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
        openOrCreateProject({
          keaHome: corruptHome,
          cwd: dir,
          runtime: runtimeFromStream(simpleStream),
          modelConfig,
        }),
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
        openOrCreateProject({
          keaHome: versionHome,
          cwd: dir,
          runtime: runtimeFromStream(simpleStream),
          modelConfig,
        }),
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
        openOrCreateProject({
          keaHome: unreadableHome,
          cwd: dir,
          runtime: runtimeFromStream(simpleStream),
          modelConfig,
        }),
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
        openOrCreateProject({
          keaHome: duplicateHome,
          cwd: dir,
          runtime: runtimeFromStream(simpleStream),
          modelConfig,
        }),
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
