import assert from "node:assert/strict";
import test from "node:test";

import { BashTool } from "../../../src/harness/tools/bash.js";
import type { BashOperations } from "../../../src/harness/tools/bash.js";

class RecordingBashOperations implements BashOperations {
  calls: string[] = [];

  async exec(command: string): Promise<string> {
    this.calls.push(command);
    return "executed";
  }
}

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

test("bash tool blocks the complete policy before invoking its backend", async () => {
  const ops = new RecordingBashOperations();
  const tool = new BashTool(process.cwd(), ops);
  const commands = [
    "rm file.txt",
    "rm -rf /",
    "sudo true",
    "chmod 777 script.sh",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /etc/hosts",
    "echo x > /dev/sda",
  ];

  for (const command of commands) {
    const result = await tool.execute({ command }, signal());
    assert.equal(result.isError, true, command);
    assert.match(result.content, /Permission denied/, command);
  }

  assert.deepEqual(ops.calls, []);
});

test("bash tool invokes its backend for a safe command", async () => {
  const ops = new RecordingBashOperations();
  const tool = new BashTool(process.cwd(), ops);
  assert.deepEqual(
    await tool.execute({ command: "pwd" }, signal()),
    { content: "executed", isError: false },
  );
  assert.deepEqual(ops.calls, ["pwd"]);
});
