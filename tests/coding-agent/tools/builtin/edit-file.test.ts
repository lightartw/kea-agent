import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEditFileTool } from "../../../../src/coding-agent/tools/builtin/edit-file.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("edit_file exposes its name, description, and exact schema", () => {
  const tool = createEditFileTool("C:/work");
  assert.equal(tool.name, "edit_file");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.length > 0);
  assert.equal(
    tool.validate({ path: "a.txt", old_text: "old", new_text: "new" }),
    undefined,
  );
  assert.ok(tool.validate({ path: "a.txt", old_text: "", new_text: "x" }));
  assert.ok(tool.validate({ path: "a.txt", old_text: "old" }));
  assert.ok(tool.validate({ path: "a.txt", old_text: "old", new_text: "x", extra: 1 }));
});

test("edit_file replaces a single exact match", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-edit-"));
  try {
    await writeFile(join(cwd, "a.txt"), "before unique after", "utf8");
    const result = await createEditFileTool(cwd).execute(
      { path: "a.txt", old_text: "unique", new_text: "changed" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, "Edited a.txt (1 replacement)");
    assert.deepEqual(result.details, {
      path: join(cwd, "a.txt"),
      replacements: 1,
    });
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "before changed after");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edit_file rejects zero matches without writing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-edit-"));
  try {
    await writeFile(join(cwd, "a.txt"), "original", "utf8");
    const result = await createEditFileTool(cwd).execute(
      { path: "a.txt", old_text: "missing", new_text: "x" },
      signal(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /text not found/);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "original");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edit_file rejects multiple matches without writing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-edit-"));
  try {
    await writeFile(join(cwd, "a.txt"), "x x x", "utf8");
    const result = await createEditFileTool(cwd).execute(
      { path: "a.txt", old_text: "x", new_text: "y" },
      signal(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /appears 3 times/);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "x x x");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edit_file treats overlapping matches as ambiguous", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-edit-"));
  try {
    await writeFile(join(cwd, "a.txt"), "aaa", "utf8");
    const result = await createEditFileTool(cwd).execute(
      { path: "a.txt", old_text: "aa", new_text: "b" },
      signal(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /appears 2 times/);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "aaa");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edit_file edits absolute paths outside the cwd without policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-edit-"));
  const outside = await mkdtemp(join(tmpdir(), "kea-edit-outside-"));
  try {
    const target = join(outside, "note.txt");
    await writeFile(target, "before after", "utf8");
    const result = await createEditFileTool(cwd).execute(
      { path: target, old_text: "before", new_text: "outside" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(await readFile(target, "utf8"), "outside after");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("edit_file reports a missing file as an error naming the path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-edit-"));
  try {
    const result = await createEditFileTool(cwd).execute(
      { path: "missing.txt", old_text: "x", new_text: "y" },
      signal(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /Unable to edit/);
    assert.match(result.content, /missing\.txt/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
