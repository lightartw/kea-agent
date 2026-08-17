import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { createBashTool } from "../../../../src/coding-agent/tools/builtin/bash.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("bash exposes its name, description, and command-only schema", () => {
  const tool = createBashTool("C:/work");
  assert.equal(tool.name, "bash");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.length > 0);
  assert.equal(tool.validate({ command: "pwd" }), undefined);
  assert.ok(tool.validate({}));
  assert.ok(tool.validate({ command: "" }));
  assert.ok(tool.validate({ command: "pwd", extra: 1 }));
});

test("bash passes the configured cwd and formats a successful result", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const tool = createBashTool("C:/work", async (command, cwd) => {
    calls.push({ command, cwd });
    return { output: "executed", exitCode: 0 };
  });
  assert.equal(tool.name, "bash");
  assert.deepEqual(await tool.execute({ command: "pwd" }, signal()), {
    content: "executed",
    details: {
      exitCode: 0,
      truncated: false,
      totalLines: 1,
      shownLines: 1,
      totalBytes: 8,
      shownBytes: 8,
    },
    isError: false,
  });
  assert.deepEqual(calls, [{ command: "pwd", cwd: resolve("C:/work") }]);
});

test("bash substitutes (no output) for empty successful output", async () => {
  const tool = createBashTool("C:/work", async () => ({
    output: "",
    exitCode: 0,
  }));
  assert.deepEqual(await tool.execute({ command: "true" }, signal()), {
    content: "(no output)",
    details: {
      exitCode: 0,
      truncated: false,
      totalLines: 0,
      shownLines: 0,
      totalBytes: 0,
      shownBytes: 0,
    },
    isError: false,
  });
});

test("bash reports a nonzero exit as an error with the exit code appended", async () => {
  const failure = createBashTool("C:/work", async () => ({
    output: "bad output",
    exitCode: 7,
  }));
  const failed = await failure.execute({ command: "exit 7" }, signal());
  assert.equal(failed.isError, true);
  assert.match(failed.content, /bad output/);
  assert.match(failed.content, /code 7/);
});

test("bash reports a null exit as an error", async () => {
  const tool = createBashTool("C:/work", async () => ({
    output: "killed",
    exitCode: null,
  }));
  const result = await tool.execute({ command: "kill -9 $$" }, signal());
  assert.equal(result.isError, true);
  assert.match(result.content, /killed/);
  assert.match(result.content, /code null/);
});

test("bash truncates long output and reports the bounded metrics", async () => {
  const lines = Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`);
  const tool = createBashTool("C:/work", async () => ({
    output: lines.join("\n"),
    exitCode: 0,
  }));
  const result = await tool.execute({ command: "seq 3000" }, signal());
  assert.equal(result.isError, false);
  assert.equal(result.details?.truncated, true);
  assert.equal(result.details?.totalLines, 3_000);
  assert.equal(result.details?.shownLines, 2_000);
  assert.match(result.content, /line-3000\n\n\[Output truncated: showing 2000 of 3000 lines and \d+ of \d+ bytes\]$/);
});

test("bash never emits invalid UTF-8 after truncation", async () => {
  const tool = createBashTool("C:/work", async () => ({
    output: "目录".repeat(20_000),
    exitCode: 0,
  }));
  const result = await tool.execute({ command: "echo" }, signal());
  assert.equal(result.details?.truncated, true);
  assert.equal(Buffer.from(result.content, "utf8").toString("utf8"), result.content);
});

test("bash propagates a rejected backend as a failed execution", async () => {
  const tool = createBashTool("C:/work", async () => {
    throw new Error("boom");
  });
  await assert.rejects(
    tool.execute({ command: "pwd" }, signal()),
    /boom/,
  );
});

test("bash forwards an already-aborted signal to the backend", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const tool = createBashTool("C:/work", async (_command, _cwd, signal) => {
    if (signal.aborted) throw signal.reason;
    return { output: "never", exitCode: 0 };
  });
  await assert.rejects(
    tool.execute({ command: "pwd" }, controller.signal),
    /cancelled/,
  );
});
