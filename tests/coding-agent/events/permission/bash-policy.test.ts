import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBashCommand,
  hardDeniedBashReason,
} from "../../../../src/coding-agent/events/permission/bash-policy.js";

test("Bash policy hard-denies commands that must never reach UI", () => {
  for (const command of [
    "sudo true",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /dev/sda",
    "rm -rf /",
    "rm -r -f /",
    "rm --recursive --force /",
    "rm --force --recursive /*",
  ]) {
    assert.equal(classifyBashCommand(command).decision, "deny", command);
    assert.ok(hardDeniedBashReason(command), command);
  }
});

test("Bash policy asks only for the teaching risk rules", () => {
  for (const command of [
    "rm file.txt",
    "echo x > /etc/hosts",
    "chmod 777 script.sh",
  ]) {
    assert.equal(classifyBashCommand(command).decision, "ask", command);
    assert.equal(hardDeniedBashReason(command), undefined, command);
  }
});

test("Bash policy allows ordinary commands", () => {
  for (const command of [
    "pwd",
    "npm test",
    "git status",
    "echo sudo",
    "printf 'sudo is disabled'",
  ]) {
    assert.deepEqual(classifyBashCommand(command), { decision: "allow" });
  }
});
