import assert from "node:assert/strict";
import test from "node:test";

import { createCodingHookRegistry } from "../../../src/coding-agent/hooks/factory.js";
import type { CodingHookUI } from "../../../src/coding-agent/types.js";

class RecordingUI implements CodingHookUI {
  readonly available = true;
  readonly confirmations: string[] = [];
  readonly notifications: string[] = [];

  async confirm(confirmation: { source: string }): Promise<boolean> {
    this.confirmations.push(confirmation.source);
    return true;
  }

  notify(notification: { source: string }): void {
    this.notifications.push(notification.source);
  }
}

test("default registry registers only the permission Hook", async () => {
  const ui = new RecordingUI();
  const hooks = createCodingHookRegistry({ cwd: process.cwd(), ui });

  // Non-bash tool calls pass through without confirmation.
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "write_file",
    input: { path: "inside.txt", content: "ok" },
  });
  assert.deepEqual(ui.confirmations, []);

  // Bash ask commands trigger a permission confirmation.
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c2",
    toolName: "bash",
    input: { command: "rm file.txt" },
  });
  assert.deepEqual(ui.confirmations, ["permission"]);
});

test("default registry produces no passive notifications", async () => {
  const ui = new RecordingUI();
  const hooks = createCodingHookRegistry({ cwd: process.cwd(), ui });

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

  assert.deepEqual(ui.notifications, []);
});
