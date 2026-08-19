import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveProjectDirectory } from "../../../src/coding-agent/cli/project-directory.js";

const execFileAsync = promisify(execFile);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-discovery-"));
}

test("Git subdirectories resolve to the canonical work-tree root", async () => {
  const root = await tempDir();
  const child = join(root, "src");
  try {
    await mkdir(child);
    await execFileAsync("git", ["init"], { cwd: root });
    assert.equal(await resolveProjectDirectory(child), await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-Git directory resolves to its canonical self", async () => {
  const directory = await tempDir();
  try {
    assert.equal(
      await resolveProjectDirectory(directory),
      await realpath(directory),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing path and a file path fail with context", async () => {
  const directory = await tempDir();
  try {
    await assert.rejects(
      resolveProjectDirectory(join(directory, "missing")),
      /does not exist/i,
    );

    const file = join(directory, "file.txt");
    await writeFile(file, "not a directory");
    await assert.rejects(
      resolveProjectDirectory(file),
      /is not a directory/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Windows cannot spawn a fake git.cmd through execFile (only .exe), so the
// empty-output case is exercised on platforms with an executable bit.
test("empty successful Git output fails instead of falling back to the startup directory",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await tempDir();
    const bin = await tempDir();
    const originalPath = process.env["PATH"];
    try {
      const git = join(bin, "git");
      await writeFile(git, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env["PATH"] = bin;

      await assert.rejects(
        resolveProjectDirectory(directory),
        /Unable to determine the Git work-tree root/i,
      );
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
      await rm(directory, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });

test("a missing Git executable fails instead of treating the directory as non-Git", async () => {
  const directory = await tempDir();
  const emptyPath = await tempDir();
  const originalPath = process.env["PATH"];
  try {
    process.env["PATH"] = emptyPath;
    await assert.rejects(
      resolveProjectDirectory(directory),
      /Unable to determine the Git work-tree root/i,
    );
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(directory, { recursive: true, force: true });
    await rm(emptyPath, { recursive: true, force: true });
  }
});

test("Git errors other than not-a-repository fail with context", async () => {
  const directory = await tempDir();
  const invalidConfig = join(directory, "invalid.gitconfig");
  const originalGlobalConfig = process.env["GIT_CONFIG_GLOBAL"];
  const originalNoSystem = process.env["GIT_CONFIG_NOSYSTEM"];
  try {
    await writeFile(invalidConfig, "[invalid\n");
    process.env["GIT_CONFIG_GLOBAL"] = invalidConfig;
    process.env["GIT_CONFIG_NOSYSTEM"] = "1";

    await assert.rejects(
      resolveProjectDirectory(directory),
      /Unable to determine the Git work-tree root/i,
    );
  } finally {
    if (originalGlobalConfig === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
    else process.env["GIT_CONFIG_GLOBAL"] = originalGlobalConfig;
    if (originalNoSystem === undefined) delete process.env["GIT_CONFIG_NOSYSTEM"];
    else process.env["GIT_CONFIG_NOSYSTEM"] = originalNoSystem;
    await rm(directory, { recursive: true, force: true });
  }
});
