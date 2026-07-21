import assert from "node:assert/strict";
import test from "node:test";

import { BashTool } from "../../src/tools/builtin/bash.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("BashTool captures output", async () => {
  assert.equal(await new BashTool().execute({ command: "echo ok" }, signal()), "ok");
});

test("BashTool preserves UTF-8 command output", async () => {
  assert.equal(await new BashTool().execute({ command: "echo 目录" }, signal()), "目录");
});

test("BashTool uses its configured working directory", async () => {
  const output = await new BashTool(process.cwd()).execute(
    { command: "pwd" },
    signal(),
  );
  assert.match(output.replaceAll("\\", "/"), /kea_agent$/i);
});

test("BashTool reports command failures", async () => {
  await assert.rejects(new BashTool().execute({ command: "exit 7" }, signal()), /code 7/);
});

test("BashTool blocks dangerous commands", async () => {
  await assert.rejects(
    new BashTool().execute({ command: "shutdown now" }, signal()),
    /Dangerous command blocked/,
  );
});
