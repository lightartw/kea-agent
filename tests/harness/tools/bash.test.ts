import assert from "node:assert/strict";
import test from "node:test";

import { BashTool } from "../../../src/harness/tools/bash.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("bash tool captures output", async () => {
  const tool = new BashTool();
  const result = await tool.execute({ command: "echo ok" }, signal());
  assert.equal(result.content, "ok");
  assert.equal(result.isError, false);
});

test("bash tool preserves UTF-8 command output", async () => {
  const tool = new BashTool();
  const result = await tool.execute({ command: "echo 目录" }, signal());
  assert.equal(result.content, "目录");
});

test("bash tool uses its configured working directory", async () => {
  const tool = new BashTool(process.cwd());
  const result = await tool.execute({ command: "pwd" }, signal());
  assert.match(result.content.replaceAll("\\", "/"), /kea_agent$/i);
});

test("bash tool reports command failures", async () => {
  const tool = new BashTool();
  const result = await tool.execute({ command: "exit 7" }, signal());
  assert.equal(result.isError, true);
  assert.match(result.content, /code 7/);
});

test("bash tool blocks every dangerous fragment as a final backstop", async () => {
  const tool = new BashTool();
  const commands = [
    "rm -rf /",
    "sudo true",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /dev/sda",
  ];

  for (const command of commands) {
    const result = await tool.execute({ command }, signal());
    assert.equal(result.isError, true, command);
    assert.match(result.content, /Dangerous command blocked/, command);
  }
});
