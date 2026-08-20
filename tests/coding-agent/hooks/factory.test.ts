import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";

import type { AgentToolCall } from "../../../src/core/harness/tools/types.js";
import { createHooks } from "../../../src/coding-agent/hooks/factory.js";
import type { PermissionRule } from "../../../src/coding-agent/hooks/permission/permission.js";
import type { UserInteraction } from "../../../src/coding-agent/interaction/interactions.js";

const PROJECT = resolve(join("work", "project"));

const testInteraction: UserInteraction = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
};

function bashCall(command: string): AgentToolCall {
  return { type: "toolCall", id: "c1", name: "bash", arguments: { command } };
}

const hookCtx = { sessionId: "s", runId: "r", cwd: PROJECT };

test("createHooks returns a HarnessHooks with Permission wired as beforeTool", async () => {
  const hooks = createHooks({
    approved: [] as PermissionRule[],
    interaction: testInteraction,
    trustedDirectories: [PROJECT],
  });

  assert.deepEqual(
    await hooks.beforeTool(bashCall("echo hello"), hookCtx),
    { kind: "allow" },
  );
  assert.deepEqual(
    await hooks.beforeTool(bashCall("sudo true"), hookCtx),
    { kind: "deny", reason: "sudo is not allowed" },
  );
});
