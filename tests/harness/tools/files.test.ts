import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEditFileDefinition,
  createReadFileDefinition,
  createWriteFileDefinition,
} from "../../../src/harness/tools/files.js";
import { createGlobDefinition } from "../../../src/harness/tools/glob.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("file tools stay in the workspace and edit content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kea-tools-"));
  try {
    const write = createWriteFileDefinition(workspace);
    const read = createReadFileDefinition(workspace);
    const edit = createEditFileDefinition(workspace);

    assert.equal(
      await write.execute({ path: "nested/example.txt", content: "first\nsecond\nthird" }, signal()),
      "Wrote 18 bytes to nested/example.txt",
    );
    assert.equal(
      await read.execute({ path: "nested/example.txt", limit: 2 }, signal()),
      "first\nsecond\n... (1 more lines)",
    );
    assert.equal(
      await edit.execute({ path: "nested/example.txt", old_text: "second", new_text: "changed" }, signal()),
      "Edited nested/example.txt",
    );
    assert.equal(
      await read.execute({ path: "nested/example.txt" }, signal()),
      "first\nchanged\nthird",
    );
    await assert.rejects(read.execute({ path: "../outside.txt" }, signal()), /escapes workspace/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("GlobTool returns workspace-relative matches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kea-tools-"));
  try {
    await createWriteFileDefinition(workspace).execute({ path: "nested/example.txt", content: "ok" }, signal());
    assert.equal(await createGlobDefinition(workspace).execute({ pattern: "**/*.txt" }, signal()), "nested/example.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
