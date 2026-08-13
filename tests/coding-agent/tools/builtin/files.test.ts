import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { safePath } from "../../../../src/utils/workspace.js";
import {
  createReadFileToolDefinition,
  createWriteFileToolDefinition,
  createEditFileToolDefinition,
  createGlobToolDefinition,
} from "../../../../src/coding-agent/tools/builtin/files.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("safePath accepts Project-contained targets across multiple directories", () => {
  const primary = resolve("D:/projects/primary");
  const notes = resolve("D:/projects/notes");
  const outside = resolve("D:/elsewhere/secret.txt");
  const cwd = join(primary, "src");

  assert.equal(
    safePath(cwd, [primary, notes], "index.ts"),
    join(primary, "src", "index.ts"),
  );
  assert.equal(
    safePath(cwd, [primary, notes], join(notes, "plan.md")),
    join(notes, "plan.md"),
  );
  assert.throws(
    () => safePath(cwd, [primary, notes], outside),
    /escapes project directories/,
  );
  assert.equal(
    safePath(cwd, [primary, notes], "../README.md"),
    join(primary, "README.md"),
  );
});

test("file tools stay within Project directories and edit content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kea-tools-"));
  try {
    const context = { cwd: workspace, directories: [workspace] };
    const write = createWriteFileToolDefinition();
    const read = createReadFileToolDefinition();
    const edit = createEditFileToolDefinition();

    assert.equal(
      (await write.execute({ path: "nested/example.txt", content: "first\nsecond\nthird" }, signal(), context)).content,
      "Wrote 18 bytes to nested/example.txt",
    );
    assert.equal(
      (await read.execute({ path: "nested/example.txt", limit: 2 }, signal(), context)).content,
      "first\nsecond\n... (1 more lines)",
    );
    assert.equal(
      (await edit.execute({ path: "nested/example.txt", old_text: "second", new_text: "changed" }, signal(), context)).content,
      "Edited nested/example.txt",
    );
    assert.equal(
      (await read.execute({ path: "nested/example.txt" }, signal(), context)).content,
      "first\nchanged\nthird",
    );
    await assert.rejects(
      read.execute({ path: "../outside.txt" }, signal(), context),
      /escapes project directories/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("GlobTool returns workspace-relative matches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kea-tools-"));
  try {
    const context = { cwd: workspace, directories: [workspace] };
    await createWriteFileToolDefinition().execute({ path: "nested/example.txt", content: "ok" }, signal(), context);
    assert.equal((await createGlobToolDefinition().execute({ pattern: "**/*.txt" }, signal(), context)).content, "nested/example.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file tools resolve relative input from cwd but accept other Project directories", async () => {
  const primary = await mkdtemp(join(tmpdir(), "kea-primary-"));
  const notes = await mkdtemp(join(tmpdir(), "kea-notes-"));
  try {
    const cwd = join(primary, "src");
    const context = { cwd, directories: [primary, notes] };
    const write = createWriteFileToolDefinition();

    // Relative path resolves from cwd.
    assert.equal(
      (await write.execute({ path: "index.ts", content: "x" }, signal(), context)).content,
      `Wrote 1 bytes to index.ts`,
    );

    // Absolute path into another Project directory is accepted.
    assert.equal(
      (await write.execute({ path: join(notes, "plan.md"), content: "plan" }, signal(), context)).content,
      `Wrote 4 bytes to ${join(notes, "plan.md")}`,
    );

    // Absolute path outside every Project directory is rejected.
    const outside = await mkdtemp(join(tmpdir(), "kea-outside-"));
    try {
      await assert.rejects(
        write.execute({ path: join(outside, "x.txt"), content: "x" }, signal(), context),
        /escapes project directories/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(primary, { recursive: true, force: true });
    await rm(notes, { recursive: true, force: true });
  }
});
