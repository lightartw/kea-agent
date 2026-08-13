import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  applyProjectUpdate,
  assertDirectoryOwnership,
  openOrCreateProject,
  persistProject,
  readProjectInfo,
} from "../../../src/coding-agent/project/storage.js";
import type { ProjectInfo } from "../../../src/coding-agent/project/types.js";

const execFileAsync = promisify(execFile);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-project-"));
}

async function gitInit(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
}

function validProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  const directory = resolve("D:/projects/research");
  return {
    id: "project_123",
    name: "research",
    directories: [directory],
    primaryDirectory: directory,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

// ── Step 1: Project-format tests ──

test("creates and reopens one persistent Project", async () => {
  const keaHome = await tempDir();
  const projectDir = await tempDir();
  try {
    const opened = await openOrCreateProject({ keaHome, directory: projectDir });
    assert.equal(opened.info.name, basename(projectDir));
    assert.deepEqual(opened.info.directories, [resolve(projectDir)]);
    assert.equal(opened.info.primaryDirectory, resolve(projectDir));

    await mkdir(join(projectDir, "src"), { recursive: true });
    const reopened = await openOrCreateProject({
      keaHome,
      directory: join(projectDir, "src"),
    });
    assert.equal(reopened.info.id, opened.info.id);
    assert.equal(reopened.storageDir, opened.storageDir);
    assert.equal(reopened.initialCwd, resolve(projectDir, "src"));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("updates Project state without changing identity", () => {
  const project = validProject();
  const next = applyProjectUpdate(project, {
    name: "research",
    directories: [resolve("D:/projects/one"), resolve("D:/projects/two")],
    primaryDirectory: resolve("D:/projects/two"),
  });
  assert.equal(next.id, project.id);
  assert.equal(next.createdAt, project.createdAt);
  assert.equal(next.name, "research");
  assert.deepEqual(next.directories, [resolve("D:/projects/one"), resolve("D:/projects/two")]);
  assert.equal(next.primaryDirectory, resolve("D:/projects/two"));
  assert.notEqual(next.updatedAt, project.updatedAt);
});

test("applyProjectUpdate rejects invalid inputs", () => {
  const project = validProject();

  assert.throws(() => applyProjectUpdate(project, { name: "  " }), /empty/);
  assert.throws(() => applyProjectUpdate(project, { directories: [] }), /at least one/);
  assert.throws(
    () => applyProjectUpdate(project, {
      directories: [resolve("D:/projects/a"), resolve("D:/projects/a")],
    }),
    /duplicated/,
  );
  assert.throws(
    () => applyProjectUpdate(project, { primaryDirectory: resolve("D:/projects/outside") }),
    /must be registered/,
  );
});

test("readProjectInfo rejects malformed project files", async () => {
  const keaHome = await tempDir();
  const directory = resolve("D:/projects/research");
  try {
    await persistProject(keaHome, validProject());
    const persisted = await readProjectInfo(keaHome, "project_123");
    assert.equal(persisted.id, "project_123");
    assert.equal(persisted.primaryDirectory, directory);

    await writeFile(
      join(keaHome, "projects", "project_123", "project.json"),
      JSON.stringify({ ...validProject(), version: 2 }),
    );
    await assert.rejects(readProjectInfo(keaHome, "project_123"), /invalid/);

    await writeFile(
      join(keaHome, "projects", "project_123", "project.json"),
      JSON.stringify({ version: 1, ...validProject(), createdAt: "not-a-date" }),
    );
    await assert.rejects(readProjectInfo(keaHome, "project_123"), /invalid/);

    await writeFile(
      join(keaHome, "projects", "project_123", "project.json"),
      JSON.stringify({ version: 1, ...validProject(), name: "" }),
    );
    await assert.rejects(readProjectInfo(keaHome, "project_123"), /invalid/);

    await writeFile(
      join(keaHome, "projects", "project_123", "project.json"),
      JSON.stringify({
        version: 1,
        ...validProject(),
        directories: [directory, resolve("D:/projects/research")],
      }),
    );
    await assert.rejects(readProjectInfo(keaHome, "project_123"), /duplicated/);

    await writeFile(
      join(keaHome, "projects", "project_123", "project.json"),
      JSON.stringify({ version: 1, ...validProject(), primaryDirectory: resolve("D:/projects/other") }),
    );
    await assert.rejects(readProjectInfo(keaHome, "project_123"), /must be registered/);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

// ── Step 4: Discovery tests ──

test("registered directory match wins over explicit unregistered nested paths", async () => {
  const keaHome = await tempDir();
  const root = await tempDir();
  try {
    const existing = await openOrCreateProject({ keaHome, directory: root });
    await mkdir(join(root, "packages", "web"), { recursive: true });
    const reopened = await openOrCreateProject({
      keaHome,
      directory: join(root, "packages", "web"),
    });
    assert.equal(reopened.info.id, existing.info.id);
    assert.equal(reopened.initialCwd, resolve(root, "packages", "web"));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("nested registered directories select the longest matching path", async () => {
  const keaHome = await tempDir();
  const root = await tempDir();
  const child = join(root, "child");
  try {
    await mkdir(child, { recursive: true });
    await mkdir(join(child, "grand"), { recursive: true });

    const outer = await openOrCreateProject({ keaHome, directory: root });
    const now = new Date().toISOString();
    const inner: ProjectInfo = {
      id: "project_inner",
      name: "child",
      directories: [resolve(child)],
      primaryDirectory: resolve(child),
      createdAt: now,
      updatedAt: now,
    };
    await persistProject(keaHome, inner);

    const reopened = await openOrCreateProject({
      keaHome,
      directory: join(child, "grand"),
    });
    assert.equal(reopened.info.id, inner.id);
    assert.notEqual(reopened.info.id, outer.info.id);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("persisting a directory already owned by another Project is rejected", async () => {
  const keaHome = await tempDir();
  const dirA = await tempDir();
  try {
    await openOrCreateProject({ keaHome, directory: dirA });
    await assert.rejects(
      assertDirectoryOwnership(keaHome, "project_other", [dirA]),
      /owned by Project/,
    );
    await assertDirectoryOwnership(keaHome, "project_other", [await tempDir()]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
  }
});

test("explicit unregistered directory is used without Git traversal", async () => {
  const keaHome = await tempDir();
  const repo = await tempDir();
  try {
    await gitInit(repo);
    const sub = join(repo, "src");
    await mkdir(sub, { recursive: true });
    const opened = await openOrCreateProject({ keaHome, directory: sub });
    assert.equal(opened.info.primaryDirectory, resolve(sub));
    assert.notEqual(opened.info.primaryDirectory, resolve(repo));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("implicit Git subdirectory resolves to the work-tree root", async () => {
  const keaHome = await tempDir();
  const repo = await tempDir();
  try {
    await gitInit(repo);
    const sub = join(repo, "packages", "web");
    await mkdir(sub, { recursive: true });
    const opened = await openOrCreateProject({ keaHome, cwd: sub });
    assert.equal(opened.info.primaryDirectory, resolve(repo));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("implicit non-Git directory remains the supplied cwd", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    const opened = await openOrCreateProject({ keaHome, cwd: dir });
    assert.equal(opened.info.primaryDirectory, resolve(dir));
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing paths and regular files are rejected", async () => {
  const keaHome = await tempDir();
  const dir = await tempDir();
  try {
    await assert.rejects(
      openOrCreateProject({ keaHome, directory: join(dir, "missing") }),
      /does not exist/,
    );

    const file = join(dir, "file.txt");
    await writeFile(file, "not a directory");
    await assert.rejects(
      openOrCreateProject({ keaHome, directory: file }),
      /is not a directory/,
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
