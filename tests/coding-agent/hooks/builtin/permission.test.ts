import assert from "node:assert/strict";
import test from "node:test";

import { HookRegistry } from "../../../../src/agent/hooks/registry.js";
import type {
  CodingHookContext,
  CodingAgentInteractions,
  ConfirmationRequest,
} from "../../../../src/coding-agent/index.js";
import { registerPermissionHook } from "../../../../src/coding-agent/hooks/builtin/permission.js";
import { classifyBashCommand, hardDeniedBashReason } from "../../../../src/coding-agent/tools/builtin/bash/policy.js";

// ── Step 1: Bash classification tests ──

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
  for (const command of ["pwd", "npm test", "git status"]) {
    assert.deepEqual(classifyBashCommand(command), { decision: "allow" });
  }
});

// ── Step 2: Permission Hook allow/ask/deny tests ──

class RecordingUI implements CodingAgentInteractions {
  readonly confirmations: ConfirmationRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(
    readonly available: boolean,
    private readonly answer: boolean | Error,
  ) {}

  async confirm(
    request: ConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.confirmations.push(request);
    this.signals.push(signal);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }

  notify(): void {}
}

type CodingHookRegistry = HookRegistry<CodingHookContext>;

function codingHooks(ui: CodingAgentInteractions): CodingHookRegistry {
  return new HookRegistry<CodingHookContext>({
    cwd: process.cwd(),
    interactions: ui,
  });
}

function triggerBash(
  hooks: CodingHookRegistry,
  command: string,
  signal?: AbortSignal,
) {
  return hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: { command },
  }, signal);
}

test("permission hard-deny never asks UI", async () => {
  const ui = new RecordingUI(true, true);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);

  const result = await triggerBash(hooks, "sudo true");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /sudo/);
  assert.deepEqual(ui.confirmations, []);
});

test("permission asks for rm and accepts explicit approval", async () => {
  const ui = new RecordingUI(true, true);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);

  assert.equal(await triggerBash(hooks, "rm file.txt"), undefined);
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.confirmations[0]?.source, "permission");
  assert.equal(ui.confirmations[0]?.title, "Allow Bash command?");
  assert.match(ui.confirmations[0]?.message ?? "", /rm file\.txt/);
});

test("permission fails closed without UI, on decline, and on UI error", async () => {
  const cases = [
    new RecordingUI(false, true),
    new RecordingUI(true, false),
    new RecordingUI(true, new Error("ui failed")),
  ];
  for (const ui of cases) {
    const hooks = codingHooks(ui);
    registerPermissionHook(hooks);
    const result = await triggerBash(hooks, "rm file.txt");
    assert.equal(result?.block, true);
  }
});

test("permission ignores non-bash tools and safe Bash commands", async () => {
  const ui = new RecordingUI(true, false);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);
  assert.equal(await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "write_file",
    input: { path: "inside.txt", content: "ok" },
  }), undefined);
  assert.equal(await triggerBash(hooks, "pwd"), undefined);
  assert.deepEqual(ui.confirmations, []);
});

test("permission forwards the run signal to UI", async () => {
  const ui = new RecordingUI(true, true);
  const hooks = codingHooks(ui);
  registerPermissionHook(hooks);
  const controller = new AbortController();

  await triggerBash(hooks, "rm file.txt", controller.signal);
  assert.equal(ui.signals[0], controller.signal);
});
