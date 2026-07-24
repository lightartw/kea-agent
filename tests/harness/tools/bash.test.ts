import assert from "node:assert/strict";
import test from "node:test";

import { BashTool } from "../../../src/harness/tools/bash.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("bash tool captures output", async () => {
  const tool = new BashTool();
  assert.equal(await tool.execute({ command: "echo ok" }, signal()), "ok");
});

test("bash tool preserves UTF-8 command output", async () => {
  const tool = new BashTool();
  assert.equal(await tool.execute({ command: "echo 目录" }, signal()), "目录");
});

test("bash tool uses its configured working directory", async () => {
  const tool = new BashTool(process.cwd());
  const output = await tool.execute({ command: "pwd" }, signal());
  assert.match(output.replaceAll("\\", "/"), /kea_agent$/i);
});

test("bash tool reports command failures", async () => {
  const tool = new BashTool();
  await assert.rejects(tool.execute({ command: "exit 7" }, signal()), /code 7/);
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
    await assert.rejects(
      tool.execute({ command }, signal()),
      /Dangerous command blocked/,
      command,
    );
  }
});
