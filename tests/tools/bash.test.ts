import assert from "node:assert/strict";
import test from "node:test";

import { BashTool } from "../../src/tools/builtin/bash.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("BashTool captures output", async () => {
  assert.equal(await new BashTool().execute({ command: "echo ok" }, signal()), "ok");
});

test("BashTool decodes Chinese Windows command output", {
  skip: process.platform !== "win32",
}, async () => {
  assert.equal(await new BashTool().execute({ command: "echo 目录" }, signal()), "目录");
});

test("BashTool uses its configured working directory", async () => {
  const output = await new BashTool(process.cwd()).execute(
    { command: process.platform === "win32" ? "cd" : "pwd" },
    signal(),
  );
  assert.match(output, /kea_agent/);
});

test("BashTool reports command failures", async () => {
  const command = process.platform === "win32" ? "exit /b 7" : "exit 7";
  await assert.rejects(new BashTool().execute({ command }, signal()), /code 7/);
});

test("BashTool blocks dangerous commands", async () => {
  await assert.rejects(
    new BashTool().execute({ command: "shutdown now" }, signal()),
    /Dangerous command blocked/,
  );
});
