import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGlobTool } from "../../../../src/coding-agent/tools/builtin/glob.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("glob exposes its name, description, and exact schema", () => {
  const tool = createGlobTool("C:/work");
  assert.equal(tool.name, "glob");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.length > 0);
  assert.equal(tool.validate({ pattern: "**/*.txt" }), undefined);
  assert.ok(tool.validate({}));
  assert.ok(tool.validate({ pattern: "" }));
  assert.ok(tool.validate({ pattern: "**", extra: 1 }));
});

test("glob returns slash-normalized matches with details", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-glob-"));
  try {
    await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "a.txt"), "a", "utf8");
    await writeFile(join(cwd, "nested", "b.txt"), "b", "utf8");
    const result = await createGlobTool(cwd).execute(
      { pattern: "**/*.txt" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, ["a.txt", "nested/b.txt"].join("\n"));
    assert.deepEqual(result.details, {
      total: 2,
      returned: 2,
      bytes: Buffer.byteLength("a.txt\nnested/b.txt", "utf8"),
      truncated: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("glob reports (no matches) for an empty result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-glob-"));
  try {
    const result = await createGlobTool(cwd).execute(
      { pattern: "**/*.md" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, "(no matches)");
    assert.deepEqual(result.details, {
      total: 0,
      returned: 0,
      bytes: 0,
      truncated: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("glob sorts matches independently of creation order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-glob-"));
  try {
    await writeFile(join(cwd, "z.txt"), "z", "utf8");
    await writeFile(join(cwd, "a.txt"), "a", "utf8");
    await writeFile(join(cwd, "m.txt"), "m", "utf8");
    const result = await createGlobTool(cwd).execute(
      { pattern: "*.txt" },
      signal(),
    );
    assert.equal(result.content, "a.txt\nm.txt\nz.txt");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("glob eliminates duplicate matches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-glob-"));
  try {
    await writeFile(join(cwd, "a.txt"), "a", "utf8");
    const result = await createGlobTool(cwd).execute(
      { pattern: "{a.txt,*.txt}" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, "a.txt");
    assert.equal(result.details?.total, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("glob truncates past 1,000 matches with a visible footer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-glob-"));
  try {
    for (let index = 0; index <= 1_000; index += 1) {
      await writeFile(
        join(cwd, `item-${String(index).padStart(4, "0")}.txt`),
        "x",
        "utf8",
      );
    }
    const result = await createGlobTool(cwd).execute(
      { pattern: "*.txt" },
      signal(),
    );
    assert.equal(result.isError, false);
    // 1,000 match lines plus the truncation footer.
    assert.equal(result.content.split("\n").length, 1_001);
    assert.equal(result.content.split("\n")[0], "item-0000.txt");
    assert.equal(result.details?.total, 1_001);
    assert.equal(result.details?.returned, 1_000);
    assert.equal(result.details?.truncated, true);
    assert.match(result.content, /\[Showing 1000 of 1001 matches\]$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("glob follows a ../ pattern outside the cwd without policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "kea-glob-root-"));
  try {
    const cwd = join(root, "work");
    const other = join(root, "other");
    await mkdir(cwd);
    await mkdir(other);
    await writeFile(join(other, "note.txt"), "outside", "utf8");
    const result = await createGlobTool(cwd).execute(
      { pattern: "../other/note.txt" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, "../other/note.txt");
    assert.equal(result.details?.total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
