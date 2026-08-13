import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultCodingHookRegistry } from "../../../../src/coding-agent/hooks/builtin/factory.js";
import type { CodingAgentInteractions } from "../../../../src/coding-agent/index.js";

class RecordingInteractions implements CodingAgentInteractions {
  readonly available = true;
  readonly confirmations: string[] = [];
  readonly notifications: string[] = [];

  async confirm(request: { source: string }): Promise<boolean> {
    this.confirmations.push(request.source);
    return true;
  }

  notify(notification: { source: string }): void {
    this.notifications.push(notification.source);
  }
}

test("default registry registers only the permission Hook", async () => {
  const interactions = new RecordingInteractions();
  const hooks = createDefaultCodingHookRegistry({
    cwd: process.cwd(),
    interactions,
  });

  // Non-bash tool calls pass through without confirmation.
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "write_file",
    input: { path: "inside.txt", content: "ok" },
  });
  assert.deepEqual(interactions.confirmations, []);

  // Bash ask commands trigger a permission confirmation.
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c2",
    toolName: "bash",
    input: { command: "rm file.txt" },
  });
  assert.deepEqual(interactions.confirmations, ["permission"]);
});

test("default registry produces no passive notifications", async () => {
  const interactions = new RecordingInteractions();
  const hooks = createDefaultCodingHookRegistry({
    cwd: process.cwd(),
    interactions,
  });

  await hooks.trigger({ type: "user_prompt", prompt: "hello" });
  await hooks.trigger({
    type: "tool_result",
    toolCallId: "c3",
    toolName: "bash",
    input: { command: "pwd" },
    content: "x".repeat(100_001),
    isError: false,
  });
  await hooks.trigger({ type: "stop", messages: [] });

  assert.deepEqual(interactions.notifications, []);
});
