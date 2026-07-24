import assert from "node:assert/strict";
import test from "node:test";

import { PermissionHook } from "../../src/harness/hooks/permission.js";
import { HookRegistry } from "../../src/agent/hooks/registry.js";

function execute(name: string, arguments_: Record<string, unknown>) {
  const hook = new PermissionHook();
  return hook.execute({
    type: "pre_tool_use",
    call: { type: "toolCall", id: "call-1", name, arguments: arguments_ },
  });
}

test("PermissionHook allows read-only tools", () => {
  const result = execute("read_file", { path: "README.md" });
  assert.equal(result, undefined);
});

test("PermissionHook allows file writes", () => {
  const result = execute("write_file", { path: "notes.txt", content: "x" });
  assert.equal(result, undefined);
});

test("PermissionHook allows file edits", () => {
  const result = execute("edit_file", { path: "notes.txt", old: "a", new_: "b" });
  assert.equal(result, undefined);
});

test("PermissionHook allows glob", () => {
  const result = execute("glob", { pattern: "*.ts" });
  assert.equal(result, undefined);
});

test("PermissionHook allows safe bash commands", () => {
  const result = execute("bash", { command: "pwd" });
  assert.equal(result, undefined);
});

test("PermissionHook hard-denies forbidden bash fragments", () => {
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
    const result = execute("bash", { command });
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /Permission denied/, command);
  }
});

test("PermissionHook blocks rm even in safe contexts", () => {
  const result = execute("bash", { command: "rm file.txt" });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /file deletion/);
});

test("PermissionHook blocks chmod 777", () => {
  const result = execute("bash", { command: "chmod 777 script.sh" });
  assert.equal(result?.block, true);
});

test("PermissionHook registers through the common hook interface", async () => {
  const registry = new HookRegistry();
  registry.register(new PermissionHook());

  const result = await registry.trigger({
    type: "pre_tool_use",
    call: {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "shutdown now" },
    },
  });

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Permission denied/);
});
