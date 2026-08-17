import assert from "node:assert/strict";
import test from "node:test";

import {
  type Interactions,
  type PermissionReply,
  type PermissionRequest,
} from "../../../src/coding-agent/interaction/interactions.js";

test("external-directory requests retain structured permission context", () => {
  const request: PermissionRequest = {
    kind: "external-directory",
    sessionId: "session-1",
    runId: "run-1",
    call: {
      type: "toolCall",
      id: "c1",
      name: "read_file",
      arguments: { path: "/tmp/x" },
    },
    targetPath: "/tmp/x",
    directory: "/tmp",
    reason: "outside the project",
  };

  assert.equal(request.kind, "external-directory");
  assert.equal(request.call.name, "read_file");
});

test("Interactions is a two-way port whose shape is stable", async () => {
  const adapter: Interactions = {
    async permission(_request, signal): Promise<PermissionReply> {
      signal?.throwIfAborted();
      return { kind: "deny", reason: "adapter says no" };
    },
  };
  const reply = await adapter.permission({
    kind: "dangerous-command",
    sessionId: "s",
    runId: "r",
    call: { type: "toolCall", id: "1", name: "bash", arguments: {} },
    command: "git push",
    cwd: "/work",
    reason: "network write",
  });
  assert.deepEqual(reply, { kind: "deny", reason: "adapter says no" });
});
