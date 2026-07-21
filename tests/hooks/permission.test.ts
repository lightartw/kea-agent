import assert from "node:assert/strict";
import test from "node:test";

import { PermissionHook } from "../../src/hooks/builtin/permission.js";
import { createHookRegistry } from "../../src/hooks/factory.js";
import type { PermissionRequest } from "../../src/hooks/types.js";

async function execute(
  name: string,
  arguments_: Record<string, unknown>,
  requestPermission: (request: PermissionRequest) => Promise<boolean>,
) {
  return new PermissionHook().execute(
    { type: "pre_tool_use", call: { id: "call-1", name, arguments: arguments_ } },
    { requestPermission },
  );
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

test("the built-in hook registry denies approval requests without an interaction", async () => {
  const result = await createHookRegistry().trigger({
    type: "pre_tool_use",
    call: { id: "call-1", name: "bash", arguments: { command: "pwd" } },
  });

  assert.deepEqual(result, {
    block: true,
    reason: "Permission denied: Bash command rejected by user",
  });
});
