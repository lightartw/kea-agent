import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { BashTool } from "../../src/tools/builtin/bash.js";
import { ToolExecutionError } from "../../src/tools/errors.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("BashTool captures output", async () => {
  const tool = new BashTool({ cwd: process.cwd() });
  const output = await tool.execute(
    { command: 'node -e "process.stdout.write(\'ok\')"' },
    signal(),
  );
  assert.equal(output, "ok");
});

test("BashTool decodes Chinese Windows command output", {
  skip: process.platform !== "win32",
}, async () => {
  const output = await new BashTool().execute({ command: "echo 目录" }, signal());
  assert.equal(output, "目录");
});

test("BashTool concatenates stdout before stderr", async () => {
  const output = await new BashTool().execute(
    {
      command:
        'node -e "process.stdout.write(\'out\');process.stderr.write(\'err\')"',
    },
    signal(),
  );
  assert.equal(output, "outerr");
});

test("BashTool reports empty output", async () => {
  const output = await new BashTool().execute(
    { command: 'node -e ""' },
    signal(),
  );
  assert.equal(output, "(no output)");
});

test("BashTool includes output in non-zero exit errors", async () => {
  await assert.rejects(
    new BashTool().execute(
      {
        command:
          'node -e "process.stderr.write(\'bad\');process.exit(3)"',
      },
      signal(),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.message === "Command exited with code 3\nbad",
  );
});

test("BashTool blocks dangerous fragments before spawning", async () => {
  for (const command of ["rm -rf /", "sudo echo x", "shutdown now", "reboot"]) {
    await assert.rejects(
      new BashTool().execute({ command }, signal()),
      /Dangerous command blocked/,
    );
  }
});

test("BashTool uses its configured working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kea-agent-bash-"));
  try {
    const output = await new BashTool({ cwd: directory }).execute(
      { command: 'node -e "process.stdout.write(process.cwd())"' },
      signal(),
    );
    assert.equal(resolve(output).toLowerCase(), resolve(directory).toLowerCase());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("BashTool wraps spawn failures", async () => {
  const missing = join(tmpdir(), `kea-agent-missing-${Date.now()}`);
  await assert.rejects(
    new BashTool({ cwd: missing }).execute(
      { command: 'node -e ""' },
      signal(),
    ),
    ToolExecutionError,
  );
});

test("BashTool aborts a long-running shell wrapper", async () => {
  const controller = new AbortController();
  const execution = new BashTool().execute(
    { command: 'node -e "setTimeout(() => {}, 1000)"' },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    execution,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
