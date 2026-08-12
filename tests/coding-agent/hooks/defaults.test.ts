import assert from "node:assert/strict";
import test from "node:test";

import { HookRegistry } from "../../../src/agent/hooks/registry.js";
import {
  createCodingHookRegistry,
} from "../../../src/coding-agent/hooks/factory.js";
import { registerContextInjectHook } from "../../../src/coding-agent/hooks/context-inject.js";
import { registerLogHook } from "../../../src/coding-agent/hooks/log.js";
import { registerLargeOutputHook } from "../../../src/coding-agent/hooks/large-output.js";
import { registerSummaryHook } from "../../../src/coding-agent/hooks/summary.js";
import type {
  CodingHookContext,
  CodingHookUI,
  HookNotification,
} from "../../../src/coding-agent/types.js";
import type { CodingHookRegistry } from "../../../src/coding-agent/hooks/types.js";

// ── Test helpers ──

class NotificationUI implements CodingHookUI {
  readonly available = false;
  readonly notifications: HookNotification[] = [];

  async confirm(): Promise<boolean> {
    return false;
  }

  notify(notification: HookNotification): void {
    this.notifications.push(notification);
  }
}

function setup(
  register: (hooks: CodingHookRegistry) => void,
): {
  hooks: CodingHookRegistry;
  notifications: HookNotification[];
} {
  const ui = new NotificationUI();
  const hooks = new HookRegistry<CodingHookContext>({
    cwd: process.cwd(),
    ui,
  });
  register(hooks);
  return { hooks, notifications: ui.notifications };
}

function triggerToolResult(
  hooks: CodingHookRegistry,
  content: string,
) {
  return hooks.trigger({
    type: "tool_result",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "pwd" },
    content,
    isError: false,
  });
}

// ── Step 1: Notification tests ──

test("context inject reports cwd without changing the prompt", async () => {
  const { hooks, notifications } = setup(registerContextInjectHook);
  const result = await hooks.trigger({
    type: "user_prompt",
    prompt: "hello",
  });
  assert.equal(result, undefined);
  assert.deepEqual(notifications[0], {
    source: "context_inject",
    level: "info",
    message: `[HOOK] UserPromptSubmit: working in ${process.cwd()}`,
  });
});

test("log observer sees a tool call before a later block", async () => {
  const { hooks, notifications } = setup(registerLogHook);
  hooks.register("tool_call", () => ({
    block: true,
    reason: "later block",
  }));
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "pwd" },
  });
  assert.equal(notifications[0]?.source, "tool_log");
  assert.equal(notifications[0]?.message, "[HOOK] bash(...)");
});

test("large output warns only above 100000 characters", async () => {
  const atLimit = setup(registerLargeOutputHook);
  await triggerToolResult(atLimit.hooks, "x".repeat(100_000));
  assert.deepEqual(atLimit.notifications, []);

  const aboveLimit = setup(registerLargeOutputHook);
  await triggerToolResult(aboveLimit.hooks, "x".repeat(100_001));
  assert.deepEqual(aboveLimit.notifications, [{
    source: "large_output",
    level: "warning",
    message: "[HOOK] ⚠ Large output from bash (100001 characters)",
  }]);
});

test("summary counts tool messages and allows stop", async () => {
  const { hooks, notifications } = setup(registerSummaryHook);
  const result = await hooks.trigger({
    type: "stop",
    messages: [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "c1", name: "bash", content: "one", isError: false },
      { role: "tool", toolCallId: "c2", name: "bash", content: "two", isError: true },
    ],
  });
  assert.equal(result, undefined);
  assert.deepEqual(notifications.at(-1), {
    source: "summary",
    level: "info",
    message: "[HOOK] Stop: session used 2 tool calls",
  });
});

test("factory registers all five defaults", async () => {
  const ui = new NotificationUI();
  const hooks = createCodingHookRegistry({ cwd: process.cwd(), ui });

  await hooks.trigger({ type: "user_prompt", prompt: "hello" });
  await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "pwd" },
  });
  await triggerToolResult(hooks, "x".repeat(100_001));
  await hooks.trigger({ type: "stop", messages: [] });

  assert.deepEqual(
    ui.notifications.map((notification) => notification.source),
    ["context_inject", "tool_log", "large_output", "summary"],
  );
});
