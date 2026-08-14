import assert from "node:assert/strict";
import test from "node:test";

import { Events } from "../../../src/events/events.js";
import { registerPermission } from "../../../src/coding-agent/events/builtin/permission.js";
import type {
  CodingAgentInteractions,
  ConfirmationRequest,
} from "../../../src/coding-agent/index.js";
import type { AgentToolCall, AgentToolResult } from "../../../src/agent/tools/types.js";
import { classifyBashCommand, hardDeniedBashReason } from "../../../src/coding-agent/tools/builtin/bash/bash-policy.js";

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

// ── Step 2: Permission listener allow/ask/deny tests ──

class RecordingUI implements CodingAgentInteractions {
  readonly confirmations: ConfirmationRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(
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

function bashCall(command: string): AgentToolCall {
  return {
    type: "toolCall",
    id: "c1",
    name: "bash",
    arguments: { command },
  };
}

async function interceptBash(
  events: Events,
  call: AgentToolCall,
  signal?: AbortSignal,
): Promise<AgentToolCall | AgentToolResult> {
  return events.intercept(
    "tools/pre-execute",
    call,
    async (effectiveCall) => effectiveCall,
    signal,
  );
}

test("permission hard-deny returns an error result without asking UI", async () => {
  const ui = new RecordingUI(true);
  const events = new Events();
  registerPermission(events, ui);

  const result = await interceptBash(events, bashCall("sudo true"));
  assert.deepEqual(result, {
    content: "Error: sudo is not allowed",
    isError: true,
  });
  assert.deepEqual(ui.confirmations, []);
});

test("permission asks for rm and accepts explicit approval", async () => {
  const ui = new RecordingUI(true);
  const events = new Events();
  registerPermission(events, ui);

  const result = await interceptBash(events, bashCall("rm file.txt"));
  assert.equal("name" in result, true);
  assert.equal((result as AgentToolCall).name, "bash");
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.confirmations[0]?.source, "permission");
  assert.equal(ui.confirmations[0]?.title, "Allow Bash command?");
  assert.match(ui.confirmations[0]?.message ?? "", /rm file\.txt/);
});

test("permission fails closed on decline and UI error", async () => {
  const cases = [
    new RecordingUI(false),
    new RecordingUI(new Error("ui failed")),
  ];
  for (const ui of cases) {
    const events = new Events();
    registerPermission(events, ui);
    const result = await interceptBash(events, bashCall("rm file.txt"));
    assert.equal("content" in result, true);
    assert.equal((result as AgentToolResult).isError, true);
  }
});

test("permission ignores non-bash tools and safe Bash commands", async () => {
  const ui = new RecordingUI(false);
  const events = new Events();
  registerPermission(events, ui);

  const nonBash: AgentToolCall = {
    type: "toolCall",
    id: "c1",
    name: "write_file",
    arguments: { path: "inside.txt", content: "ok" },
  };
  const first = await interceptBash(events, nonBash);
  const second = await interceptBash(events, bashCall("pwd"));
  assert.equal("name" in first, true);
  assert.equal((first as AgentToolCall).name, "write_file");
  assert.equal("name" in second, true);
  assert.equal((second as AgentToolCall).name, "bash");
  assert.deepEqual(ui.confirmations, []);
});

test("permission forwards the run signal to UI", async () => {
  const ui = new RecordingUI(true);
  const events = new Events();
  registerPermission(events, ui);
  const controller = new AbortController();

  await interceptBash(events, bashCall("rm file.txt"), controller.signal);
  assert.equal(ui.signals[0], controller.signal);
});
