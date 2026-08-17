import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReadFileTool } from "../../../../src/coding-agent/tools/builtin/read-file.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("read_file reads a relative text file with default offset and limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await writeFile(join(cwd, "a.txt"), "line-1\nline-2\nline-3", "utf8");
    const tool = createReadFileTool(cwd);
    assert.equal(tool.name, "read_file");
    assert.equal(tool.validate({ path: "a.txt" }), undefined);
    assert.ok(tool.validate({}));
    const result = await tool.execute({ path: "a.txt" }, signal());
    assert.equal(result.isError, false);
    assert.equal(result.content, "line-1\nline-2\nline-3");
    assert.deepEqual(result.details, {
      path: join(cwd, "a.txt"),
      kind: "file",
      offset: 1,
      total: 3,
      returned: 3,
      truncated: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file honors a one-based offset and limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await writeFile(
      join(cwd, "a.txt"),
      ["line-1", "line-2", "line-3", "line-4"].join("\n"),
      "utf8",
    );
    const result = await createReadFileTool(cwd).execute(
      { path: "a.txt", offset: 2, limit: 2 },
      signal(),
    );
    assert.equal(result.content, "line-2\nline-3");
    assert.deepEqual(result.details, {
      path: join(cwd, "a.txt"),
      kind: "file",
      offset: 2,
      total: 4,
      returned: 2,
      truncated: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file reports no content for an offset past EOF", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await writeFile(join(cwd, "a.txt"), "line-1\nline-2\nline-3", "utf8");
    const result = await createReadFileTool(cwd).execute(
      { path: "a.txt", offset: 10 },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, "(no content)");
    assert.equal(result.details?.total, 3);
    assert.equal(result.details?.returned, 0);
    assert.equal(result.details?.truncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file truncates files over 2000 lines and keeps the head", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    const lines = Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(cwd, "big.txt"), lines.join("\n"), "utf8");
    const result = await createReadFileTool(cwd).execute(
      { path: "big.txt" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.match(result.content, /^line-1\n/);
    assert.match(result.content, /line-2000$/);
    assert.equal(result.details?.total, 3_000);
    assert.equal(result.details?.returned, 2_000);
    assert.equal(result.details?.truncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file byte-truncates a single oversized line without invalid UTF-8", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    const text = "目录".repeat(20_000);
    await writeFile(join(cwd, "wide.txt"), text, "utf8");
    const result = await createReadFileTool(cwd).execute(
      { path: "wide.txt" },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.details?.truncated, true);
    assert.notEqual(result.content, text);
    assert.equal(Buffer.from(result.content, "utf8").toString("utf8"), result.content);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file normalizes CRLF line endings consistently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await writeFile(join(cwd, "crlf.txt"), "line-1\r\nline-2\r\n", "utf8");
    const result = await createReadFileTool(cwd).execute(
      { path: "crlf.txt" },
      signal(),
    );
    assert.equal(result.content, "line-1\nline-2");
    assert.equal(result.details?.total, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file reports no content for an empty file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    const result = await createReadFileTool(cwd).execute(
      { path: "empty.txt" },
      signal(),
    );
    assert.equal(result.content, "(no content)");
    assert.deepEqual(result.details, {
      path: join(cwd, "empty.txt"),
      kind: "file",
      offset: 1,
      total: 0,
      returned: 0,
      truncated: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file reports no entries for an empty directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await mkdir(join(cwd, "empty-dir"));
    const result = await createReadFileTool(cwd).execute(
      { path: "empty-dir" },
      signal(),
    );
    assert.equal(result.content, "(no entries)");
    assert.deepEqual(result.details, {
      path: join(cwd, "empty-dir"),
      kind: "directory",
      offset: 1,
      total: 0,
      returned: 0,
      truncated: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file lists sorted direct entries with a slash on directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    await writeFile(join(cwd, "a.txt"), "a", "utf8");
    await writeFile(join(cwd, "c.md"), "c", "utf8");
    await mkdir(join(cwd, "nested"));
    const result = await createReadFileTool(cwd).execute(
      { path: "." },
      signal(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.content, "a.txt\nc.md\nnested/");
    assert.deepEqual(result.details, {
      path: join(cwd, "."),
      kind: "directory",
      offset: 1,
      total: 3,
      returned: 3,
      truncated: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file paginates directory listings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    for (let index = 1; index <= 10; index += 1) {
      await writeFile(join(cwd, `f-${String(index).padStart(2, "0")}.txt`), "x", "utf8");
    }
    const result = await createReadFileTool(cwd).execute(
      { path: ".", offset: 2, limit: 3 },
      signal(),
    );
    assert.equal(result.content, "f-02.txt\nf-03.txt\nf-04.txt");
    assert.equal(result.details?.total, 10);
    assert.equal(result.details?.returned, 3);
    assert.equal(result.details?.truncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read_file reads absolute paths outside the cwd without policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  const outside = await mkdtemp(join(tmpdir(), "kea-read-outside-"));
  try {
    await writeFile(join(outside, "note.txt"), "outside", "utf8");
    const result = await createReadFileTool(cwd).execute(
      { path: join(outside, "note.txt") },
      signal(),
    );
    assert.equal(result.content, "outside");
    assert.equal(result.isError, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("read_file reports a missing path as an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kea-read-"));
  try {
    const result = await createReadFileTool(cwd).execute(
      { path: "missing.txt" },
      signal(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /Unable to read/);
    assert.match(result.content, /missing\.txt/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
