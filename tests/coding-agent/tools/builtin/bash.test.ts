import assert from "node:assert/strict";
import test from "node:test";

import { createBashToolDefinition } from "../../../../src/coding-agent/tools/builtin/bash/bash.js";

class RecordingBashExecution {
  calls: string[] = [];

  readonly execute = async (command: string): Promise<string> => {
    this.calls.push(command);
    return "executed";
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const context = { cwd: process.cwd(), directories: [process.cwd()] };

test("bash tool captures output", async () => {
  const definition = createBashToolDefinition();
  const result = await definition.execute({ command: "echo ok" }, signal(), context);
  assert.equal(result.content, "ok");
  assert.equal(result.isError, false);
});

test("bash tool preserves UTF-8 command output", async () => {
  const definition = createBashToolDefinition();
  const result = await definition.execute({ command: "echo 目录" }, signal(), context);
  assert.equal(result.content, "目录");
});

test("bash tool uses its configured working directory", async () => {
  const definition = createBashToolDefinition();
  const result = await definition.execute({ command: "pwd" }, signal(), context);
  assert.match(result.content.replaceAll("\\", "/"), /kea_agent$/i);
});

test("bash tool reports command failures", async () => {
  const definition = createBashToolDefinition();
  const result = await definition.execute({ command: "exit 7" }, signal(), context);
  assert.equal(result.isError, true);
  assert.match(result.content, /code 7/);
});

test("bash tool independently blocks only hard-denied commands", async () => {
  const execution = new RecordingBashExecution();
  const definition = createBashToolDefinition(execution.execute);
  for (const command of [
    "rm -rf /",
    "sudo true",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /dev/sda",
  ]) {
    const result = await definition.execute({ command }, signal(), context);
    assert.equal(result.isError, true, command);
    assert.match(result.content, /Permission denied/, command);
  }
  assert.deepEqual(execution.calls, []);
});

test("bash tool leaves ask-class commands to the permission listener", async () => {
  const execution = new RecordingBashExecution();
  const definition = createBashToolDefinition(execution.execute);
  for (const command of [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]) {
    assert.equal((await definition.execute({ command }, signal(), context)).isError, false);
  }
  assert.deepEqual(execution.calls, [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]);
});

test("bash tool invokes its backend for a safe command", async () => {
  const execution = new RecordingBashExecution();
  const definition = createBashToolDefinition(execution.execute);
  assert.deepEqual(
    await definition.execute({ command: "pwd" }, signal(), context),
    { content: "executed", isError: false },
  );
  assert.deepEqual(execution.calls, ["pwd"]);
});
