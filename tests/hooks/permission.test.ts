import assert from "node:assert/strict";
import test from "node:test";

import {
  PermissionHook,
  type PermissionRequest,
} from "../../src/hooks/builtin/permission.js";
import { HookRegistry } from "../../src/hooks/registry.js";

async function execute(
  name: string,
  arguments_: Record<string, unknown>,
  requestPermission: (request: PermissionRequest) => Promise<boolean>,
) {
  return new PermissionHook(requestPermission).execute({
    id: "call-1",
    name,
    arguments: arguments_,
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

test("PermissionHook hard-denies forbidden Bash commands without prompting", async () => {
  let prompted = false;
  const result = await execute("bash", { command: "sudo reboot" }, async () => {
    prompted = true;
    return true;
  });

  assert.equal(prompted, false);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /forbidden fragment/);
});

test("PermissionHook registers through the common hook interface", async () => {
  const registry = new HookRegistry();
  registry.register(new PermissionHook(async () => false));

  const result = await registry.triggerPreToolUse({
    id: "call-1",
    name: "bash",
    arguments: { command: "pwd" },
  });

  assert.deepEqual(result, {
    block: true,
    reason: "Permission denied: Bash command rejected by user",
  });
});
