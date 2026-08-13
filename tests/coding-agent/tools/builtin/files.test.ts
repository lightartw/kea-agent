import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReadFileToolDefinition,
  createWriteFileToolDefinition,
  createEditFileToolDefinition,
  createGlobToolDefinition,
} from "../../../../src/coding-agent/tools/builtin/files.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("file tools stay in the workspace and edit content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kea-tools-"));
  try {
    const context = { cwd: workspace };
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
    await assert.rejects(read.execute({ path: "../outside.txt" }, signal(), context), /escapes workspace/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("GlobTool returns workspace-relative matches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kea-tools-"));
  try {
    const context = { cwd: workspace };
    await createWriteFileToolDefinition().execute({ path: "nested/example.txt", content: "ok" }, signal(), context);
    assert.equal((await createGlobToolDefinition().execute({ pattern: "**/*.txt" }, signal(), context)).content, "nested/example.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
