import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWriteFileTool } from "../../../../src/coding-agent/tools/builtin/write-file.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("write_file exposes its name, description, and exact schema", () => {
  const tool = createWriteFileTool("C:/work");
  assert.equal(tool.name, "write_file");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.length > 0);
  assert.equal(tool.validate({ path: "a.txt", content: "x" }), undefined);
  assert.ok(tool.validate({}));
  assert.ok(tool.validate({ path: "", content: "x" }));
  assert.ok(tool.validate({ path: "a.txt" }));
  assert.ok(tool.validate({ path: "a.txt", content: "x", extra: 1 }));
});

test("write_file creates nested parents and counts UTF-8 bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-write-"));
  try {
    const tool = createWriteFileTool(cwd);
    const created = await tool.execute(
      { path: "nested/example.txt", content: "目录" },
      signal(),
    );
    assert.equal(created.isError, false);
    assert.equal(created.content, "Created nested/example.txt (6 bytes)");
    assert.deepEqual(created.details, {
      path: join(cwd, "nested", "example.txt"),
      bytes: 6,
      created: true,
    });
    assert.equal(await readFile(join(cwd, "nested", "example.txt"), "utf8"), "目录");

    const overwritten = await tool.execute(
      { path: "nested/example.txt", content: "next" },
      signal(),
    );
    assert.equal(overwritten.content, "Overwrote nested/example.txt (4 bytes)");
    assert.deepEqual(overwritten.details, {
      path: join(cwd, "nested", "example.txt"),
      bytes: 4,
      created: false,
    });
    assert.equal(await readFile(join(cwd, "nested", "example.txt"), "utf8"), "next");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write_file accepts empty content and still creates the file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-write-"));
  try {
    const result = await createWriteFileTool(cwd).execute(
      { path: "empty.txt", content: "" },
      signal(),
    );
    assert.equal(result.content, "Created empty.txt (0 bytes)");
    assert.deepEqual(result.details, {
      path: join(cwd, "empty.txt"),
      bytes: 0,
      created: true,
    });
    assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write_file writes to absolute paths outside the cwd without policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-write-"));
  const outside = await mkdtemp(join(tmpdir(), "kea-write-outside-"));
  try {
    const target = join(outside, "note.txt");
    const result = await createWriteFileTool(cwd).execute(
      { path: target, content: "outside" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.details?.path, target);
    assert.equal(await readFile(target, "utf8"), "outside");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("write_file reports a filesystem failure as an error naming the target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-write-"));
  try {
    await mkdir(join(cwd, "blocked"));
    const result = await createWriteFileTool(cwd).execute(
      { path: "blocked", content: "x" },
      signal(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /Unable to write/);
    assert.match(result.content, /blocked/);
    assert.ok(await access(join(cwd, "blocked")).then(() => true, () => false));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
