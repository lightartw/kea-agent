import assert from "node:assert/strict";
import test from "node:test";

import {
  PermissionHook,
  type PermissionRequest,
} from "../../src/harness/hooks/permission.js";
import { HookRegistry } from "../../src/agent/hooks/registry.js";

async function execute(
  name: string,
  arguments_: Record<string, unknown>,
  requestPermission: (request: PermissionRequest) => Promise<boolean>,
) {
  const hook = new PermissionHook();
  hook.requestPermission = requestPermission;
  return hook.execute({
    type: "pre_tool_use",
    call: { type: "toolCall", id: "call-1", name, arguments: arguments_ },
  });
}

test("PermissionHook allows read-only tools without prompting", async () => {
  let prompted = false;
  const result = await execute("read_file", { path: "README.md" }, async () => {
    prompted = true;
    return false;
  });

  assert.equal(result, undefined);
  assert.equal(prompted, false);
});

test("PermissionHook asks before file changes", async () => {
  const requests: PermissionRequest[] = [];
  const result = await execute("write_file", { path: "notes.txt", content: "x" }, async (request) => {
    requests.push(request);
    return false;
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0]?.reason ?? "", /modify notes\.txt/);
  assert.deepEqual(result, {
    block: true,
    reason: "Permission denied: file change rejected by user",
  });
});

test("PermissionHook allows an approved Bash command", async () => {
  let prompted = false;
  const result = await execute("bash", { command: "pwd" }, async () => {
    prompted = true;
    return true;
  });

  assert.equal(prompted, true);
  assert.equal(result, undefined);
});

test("PermissionHook hard-denies every forbidden Bash fragment without prompting", async () => {
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
    let prompted = false;
    const result = await execute("bash", { command }, async () => {
      prompted = true;
      return true;
    });

    assert.equal(prompted, false, command);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /forbidden fragment/, command);
  }
});

test("PermissionHook reports the matched rule when asking for approval", async () => {
  const requests: PermissionRequest[] = [];
  await execute("bash", { command: "chmod 777 script.sh" }, async (request) => {
    requests.push(request);
    return false;
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0]?.reason ?? "", /potentially destructive/i);
});

test("PermissionHook registers through the common hook interface", async () => {
  const registry = new HookRegistry();
  // Default deny-all — no callback configured.
  registry.register(new PermissionHook());

  const result = await registry.trigger({
    type: "pre_tool_use",
    call: {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "pwd" },
    },
  });

  assert.deepEqual(result, {
    block: true,
    reason: "Permission denied: Bash command rejected by user",
  });
});
