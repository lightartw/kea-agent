import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ProjectStorage } from "../../../src/coding-agent/project/storage.js";
import type { ProjectInfo } from "../../../src/coding-agent/project/project.js";

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-project-"));
}

function uuid(index: number): string {
  return `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, "0")}`;
}

function validInfo(directory: string, overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: VALID_ID,
    name: "example",
    directory,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function validDocument(directory: string, overrides: Partial<ProjectInfo> = {}): Record<string, unknown> {
  return { version: 1, ...validInfo(directory, overrides) };
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

test("findByDirectory returns undefined when the projects root is missing", async () => {
  const keaHome = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    assert.equal(
      await storage.findByDirectory(resolve(join(keaHome, "anything"))),
      undefined,
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

test("create persists version 1 and all five fields; findByDirectory finds the same normalized directory", async () => {
  const keaHome = await tempDir();
  const projectDir = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    const info = validInfo(resolve(projectDir));
    await storage.create(info);

    const raw = JSON.parse(
      await readFile(join(keaHome, "projects", info.id, "project.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(raw, { version: 1, ...info });

    assert.deepEqual(await storage.findByDirectory(info.directory), info);
    assert.deepEqual(await storage.findByDirectory(`${info.directory}/sub/..`), info);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("findByDirectory compares normalized paths exactly and never parent or child", async () => {
  const keaHome = await tempDir();
  const parentDir = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    const info = validInfo(resolve(parentDir));
    await storage.create(info);

    assert.equal(await storage.findByDirectory(join(parentDir, "child")), undefined);
    assert.equal(await storage.findByDirectory(resolve(join(parentDir, ".."))), undefined);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(parentDir, { recursive: true, force: true });
  }
});

test("malformed, unsupported, and mismatched project records reject", async () => {
  const projectDir = await tempDir();
  try {
    const directory = resolve(projectDir);

    const missingName = validDocument(directory);
    delete missingName.name;

    const cases: ReadonlyArray<[string, unknown, RegExp]> = [
      ["malformed JSON", "not json", /invalid JSON/],
      ["unsupported version", { ...validDocument(directory), version: 2 }, /version/],
      ["missing field", missingName, /exactly/],
      ["extra field", { ...validDocument(directory), extra: 1 }, /exactly/],
      ["invalid timestamp", { ...validDocument(directory), createdAt: "not-a-date" }, /timestamp/],
      ["non-absolute directory", { ...validDocument(directory), directory: "relative/path" }, /directory/],
      ["invalid Project ID", { ...validDocument(directory), id: "not-a-uuid" }, /invalid/i],
    ];
    for (const [label, document, pattern] of cases) {
      const keaHome = await tempDir();
      try {
        const projectId = uuid(1);
        if (typeof document === "string") {
          await mkdir(join(keaHome, "projects", projectId), { recursive: true });
          await writeFile(
            join(keaHome, "projects", projectId, "project.json"),
            document,
          );
        } else {
          await persistDocument(keaHome, projectId, document);
        }
        const storage = new ProjectStorage(keaHome);
        await assert.rejects(storage.findByDirectory(directory), pattern, label);
      } finally {
        await rm(keaHome, { recursive: true, force: true });
      }
    }

    const mismatchHome = await tempDir();
    try {
      await persistDocument(mismatchHome, uuid(1), validDocument(directory));
      const storage = new ProjectStorage(mismatchHome);
      await assert.rejects(
        storage.findByDirectory(directory),
        /does not match/i,
        "parent directory/JSON ID mismatch",
      );
    } finally {
      await rm(mismatchHome, { recursive: true, force: true });
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("two valid records claiming the same normalized directory reject as duplicate ownership", async () => {
  const keaHome = await tempDir();
  const claimedDir = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    const directory = resolve(claimedDir);
    await persistDocument(keaHome, uuid(1), validDocument(directory, { id: uuid(1) }));
    await persistDocument(keaHome, uuid(2), validDocument(directory, { id: uuid(2) }));

    await assert.rejects(storage.findByDirectory(directory), /more than one/i);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(claimedDir, { recursive: true, force: true });
  }
});

test("a missing candidate project.json and filesystem read failures reject", async () => {
  const keaHome = await tempDir();
  const projectDir = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    const directory = resolve(projectDir);

    await mkdir(join(keaHome, "projects", uuid(1)), { recursive: true });
    await assert.rejects(storage.findByDirectory(directory), /read/i);

    await mkdir(join(keaHome, "projects", uuid(2), "project.json"), { recursive: true });
    await assert.rejects(storage.findByDirectory(directory), /read/i);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("create rejects an existing target directory without changing its contents", async () => {
  const keaHome = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    const info = validInfo(resolve(await tempDir()));

    const target = join(keaHome, "projects", info.id);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep");

    await assert.rejects(storage.create(info), /already exists/i);
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

test("a failed create removes only its own temporary directory and propagates the failure", async () => {
  const keaHome = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    const info = validInfo(resolve(await tempDir()));

    await mkdir(join(keaHome, "projects", info.id), { recursive: true });

    await assert.rejects(storage.create(info), /already exists/i);
    assert.deepEqual(await readdir(join(keaHome, "projects")), [info.id]);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

test("dataDirectory returns the projects path for a valid ID and rejects traversal or malformed IDs", async () => {
  const keaHome = await tempDir();
  try {
    const storage = new ProjectStorage(keaHome);
    assert.equal(
      storage.dataDirectory(VALID_ID),
      resolve(join(keaHome, "projects", VALID_ID)),
    );

    assert.throws(() => storage.dataDirectory("../escape"), /invalid/i);
    assert.throws(() => storage.dataDirectory("not-a-uuid"), /invalid/i);
    assert.throws(() => storage.dataDirectory(""), /invalid/i);
    assert.throws(() => storage.dataDirectory(resolve("C:/elsewhere")), /invalid/i);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});
