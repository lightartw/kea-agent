import assert from "node:assert/strict";
import test from "node:test";

import { Events } from "../../../src/events/events.js";
import type {
  AgentRunIdentity,
  ToolCallDecision,
} from "../../../src/agent/events.js";
import { registerPermission } from "../../../src/coding-agent/events/builtin/permission.js";
import type {
  CodingAgentInteractions,
  ConfirmationRequest,
} from "../../../src/coding-agent/index.js";
import { classifyBashCommand, hardDeniedBashReason } from "../../../src/coding-agent/tools/builtin/bash/bash-policy.js";

const run: AgentRunIdentity = {
  sessionId: "session-1",
  runId: "run-1",
  lane: "main",
};

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

function bashDecision(command: string): ToolCallDecision {
  return {
    ...run,
    kind: "execute",
    call: {
      type: "toolCall",
      id: "c1",
      name: "bash",
      arguments: { command },
    },
  };
}

async function transformToolCall(
  events: Events,
  decision: ToolCallDecision,
  signal?: AbortSignal,
): Promise<ToolCallDecision> {
  return events.transform("agent/tool-call", decision, signal);
}

test("permission hard-deny never asks UI", async () => {
  const ui = new RecordingUI(true);
  const events = new Events();
  registerPermission(events, ui);

  const result = await transformToolCall(events, bashDecision("sudo true"));
  assert.equal(result.kind, "reject");
  assert.ok(result.kind === "reject" && /sudo/.test(result.reason));
  assert.deepEqual(ui.confirmations, []);
});

test("permission asks for rm and accepts explicit approval", async () => {
  const ui = new RecordingUI(true);
  const events = new Events();
  registerPermission(events, ui);

  const result = await transformToolCall(events, bashDecision("rm file.txt"));
  assert.equal(result.kind, "execute");
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
    const result = await transformToolCall(events, bashDecision("rm file.txt"));
    assert.equal(result.kind, "reject");
  }
});

test("permission ignores non-bash tools and safe Bash commands", async () => {
  const ui = new RecordingUI(false);
  const events = new Events();
  registerPermission(events, ui);

  const nonBash: ToolCallDecision = {
    ...run,
    kind: "execute",
    call: {
      type: "toolCall",
      id: "c1",
      name: "write_file",
      arguments: { path: "inside.txt", content: "ok" },
    },
  };
  const first = await transformToolCall(events, nonBash);
  const second = await transformToolCall(events, bashDecision("pwd"));
  assert.equal(first.kind, "execute");
  assert.equal(second.kind, "execute");
  assert.deepEqual(ui.confirmations, []);
});

test("permission forwards the run signal to UI", async () => {
  const ui = new RecordingUI(true);
  const events = new Events();
  registerPermission(events, ui);
  const controller = new AbortController();

  await transformToolCall(events, bashDecision("rm file.txt"), controller.signal);
  assert.equal(ui.signals[0], controller.signal);
});
