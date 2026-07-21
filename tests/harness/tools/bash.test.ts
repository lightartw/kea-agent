import assert from "node:assert/strict";
import test from "node:test";

import { createBashToolDefinition } from "../../../src/harness/tools/bash.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

test("bash tool captures output", async () => {
  const def = createBashToolDefinition();
  assert.equal(await def.execute({ command: "echo ok" }, signal()), "ok");
});

test("bash tool preserves UTF-8 command output", async () => {
  const def = createBashToolDefinition();
  assert.equal(await def.execute({ command: "echo 目录" }, signal()), "目录");
});

test("bash tool uses its configured working directory", async () => {
  const def = createBashToolDefinition(process.cwd());
  const output = await def.execute({ command: "pwd" }, signal());
  assert.match(output.replaceAll("\\", "/"), /kea_agent$/i);
});

test("bash tool reports command failures", async () => {
  const def = createBashToolDefinition();
  await assert.rejects(def.execute({ command: "exit 7" }, signal()), /code 7/);
});

test("bash tool blocks every dangerous fragment as a final backstop", async () => {
  const def = createBashToolDefinition();
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
      def.execute({ command }, signal()),
      /Dangerous command blocked/,
      command,
    );
  }
});
