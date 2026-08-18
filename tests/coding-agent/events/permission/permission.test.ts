import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";

import type {
  AgentToolCall,
} from "../../../../src/core/harness/tools/types.js";
import type { ToolCallEvent } from "../../../../src/core/harness/tools/events.js";
import {
  type Interactions,
  type PermissionReply,
  type PermissionRequest,
} from "../../../../src/coding-agent/interaction/interactions.js";
import {
  decidePermission,
  type PermissionRule,
} from "../../../../src/coding-agent/events/permission/permission.js";

const PROJECT = resolve(join("work", "project"));
const CWD = PROJECT;
const OUTSIDE = resolve(join("work", "outside"));

function bashCall(command: string): AgentToolCall {
  return {
    type: "toolCall",
    id: "c1",
    name: "bash",
    arguments: { command },
  };
}

function bashEvent(command: string, sessionId = "session-1"): ToolCallEvent {
  return {
    sessionId,
    runId: "run-1",
    cwd: CWD,
    call: bashCall(command),
  };
}

function fileEvent(
  name: string,
  args: Record<string, unknown>,
): ToolCallEvent {
  return {
    sessionId: "session-1",
    runId: "run-1",
    cwd: CWD,
    call: { type: "toolCall", id: "c1", name, arguments: args },
  };
}

class RecordingInteractions implements Interactions {
  readonly requests: PermissionRequest[] = [];

  constructor(private readonly replies: PermissionReply[]) {}

  async permission(request: PermissionRequest): Promise<PermissionReply> {
    this.requests.push(request);
    const reply = this.replies.shift();
    return reply ?? { kind: "once" };
  }
}

function decide(
  input: ToolCallEvent,
  interactions: Interactions,
  approved: PermissionRule[] = [],
  cwd = CWD,
  signal?: AbortSignal,
) {
  return decidePermission(
    input,
    { cwd, trustedDirectories: [PROJECT], approved, interactions },
    signal,
  );
}

function oneInteraction(reply: PermissionReply): RecordingInteractions {
  return new RecordingInteractions([reply]);
}

// ── Bash 策略与回答（spec §12）──

test("ordinary Bash commands proceed without an interaction", async () => {
  const interactions = new RecordingInteractions([]);

  const decision = await decide(bashEvent("echo hello"), interactions);

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interactions.requests.length, 0);
});

test("hard deny uses the policy reason and never asks", async () => {
  const interactions = new RecordingInteractions([]);

  const decision = await decide(bashEvent("sudo true"), interactions);

  assert.deepEqual(decision, { kind: "deny", reason: "sudo is not allowed" });
  assert.equal(interactions.requests.length, 0);
});

test("once allows the current call but records no rule", async () => {
  const interactions = new RecordingInteractions([{ kind: "once" }]);
  const approved: PermissionRule[] = [];

  const first = await decide(bashEvent("rm file.txt"), interactions, approved);

  assert.deepEqual(first, { kind: "allow" });
  assert.deepEqual(approved, []);

  const second = await decide(bashEvent("rm file.txt"), interactions, approved);
  assert.equal(interactions.requests.length, 2);
  assert.deepEqual(second, { kind: "allow" });
});

test("always appends a command rule to the supplied approved array", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([{ kind: "always" }]);

  assert.deepEqual(
    await decide(bashEvent("rm file.txt"), interactions, approved),
    { kind: "allow" },
  );
  assert.deepEqual(approved, [
    { kind: "command", command: "rm file.txt", cwd: CWD },
  ]);

  await decide(bashEvent("rm file.txt"), interactions, approved);
  assert.equal(interactions.requests.length, 1);
});

test("approved rules are reusable by another session in one project", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([{ kind: "always" }]);

  await decide(bashEvent("rm file.txt", "session-a"), interactions, approved);
  await decide(bashEvent("rm file.txt", "session-b"), interactions, approved);

  assert.equal(interactions.requests.length, 1);
});

test("hard deny overrides a remembered allow", async () => {
  const approved: PermissionRule[] = [
    { kind: "command", command: "sudo true", cwd: CWD },
  ];
  const interactions = new RecordingInteractions([]);

  const decision = await decide(bashEvent("sudo true"), interactions, approved);

  assert.deepEqual(decision, { kind: "deny", reason: "sudo is not allowed" });
  assert.equal(interactions.requests.length, 0);
});

test("interaction failures and invalid replies close the door", async () => {
  const throwing: Interactions = {
    async permission(): Promise<PermissionReply> {
      throw new Error("adapter disconnected");
    },
  };
  const failed = await decide(bashEvent("rm file.txt"), throwing);
  assert.deepEqual(failed, {
    kind: "deny",
    reason: "Permission request failed: adapter disconnected",
  });

  const invalidReply: Interactions = {
    async permission(): Promise<PermissionReply> {
      return { kind: "maybe" } as unknown as PermissionReply;
    },
  };
  const invalid = await decide(bashEvent("rm file.txt"), invalidReply);
  assert.deepEqual(invalid, {
    kind: "deny",
    reason: "Permission request failed: invalid reply",
  });
});

test("a cancelled Run signal propagates instead of a user denial", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted");
  controller.abort(reason);
  const aborting: Interactions = {
    async permission(): Promise<PermissionReply> {
      throw reason;
    },
  };

  await assert.rejects(
    decide(bashEvent("rm file.txt"), aborting, [], CWD, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("malformed Bash arguments are denied without asking", async () => {
  const interactions = new RecordingInteractions([]);

  const decision = await decide(
    fileEvent("bash", { command: 42 }),
    interactions,
  );

  assert.deepEqual(decision, {
    kind: "deny",
    reason: "Permission request failed: invalid arguments for bash",
  });
  assert.equal(interactions.requests.length, 0);
});

// ── 外部目录（spec §7.2 / §11）──

test("trusted directories do not become approved rules", async () => {
  const approved: PermissionRule[] = [];
  const result = await decidePermission(
    fileEvent("read_file", { path: join(PROJECT, "src", "main.ts") }),
    {
      cwd: CWD,
      trustedDirectories: [PROJECT],
      approved,
      interactions: new RecordingInteractions([]),
    },
  );

  assert.deepEqual(result, { kind: "allow" });
  assert.deepEqual(approved, []);
});

test("a path outside the trusted directories asks with the full request", async () => {
  const interactions = oneInteraction({ kind: "once" });

  const decision = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interactions,
  );

  assert.deepEqual(decision, { kind: "allow" });
  const request = interactions.requests[0];
  assert.ok(request);
  assert.equal(request.kind, "external-directory");
  if (request.kind !== "external-directory") return;
  assert.equal(request.sessionId, "session-1");
  assert.equal(request.runId, "run-1");
  assert.equal(request.call.name, "read_file");
  assert.equal(request.targetPath, join(OUTSIDE, "data.txt"));
  assert.equal(request.directory, OUTSIDE);
  assert.equal(request.reason, "outside the project directory");
});

test("every path tool asks for targets outside the trusted directories", async () => {
  const tools = ["read_file", "write_file", "edit_file", "glob"] as const;
  for (const name of tools) {
    const interactions = oneInteraction({ kind: "once" });

    const decision = await decide(
      fileEvent(name, {
        ...(name === "glob"
          ? { pattern: join(OUTSIDE, "src", "*.ts") }
          : { path: join(OUTSIDE, "data.txt") }),
      }),
      interactions,
    );

    assert.deepEqual(decision, { kind: "allow" }, name);
    const request = interactions.requests[0];
    assert.ok(request);
    assert.equal(request.kind, "external-directory", name);
    if (request.kind !== "external-directory") return;
    assert.equal(request.call.name, name);
  }
});

test("glob targets use the static prefix before the first wildcard", async () => {
  const interactions = oneInteraction({ kind: "once" });

  await decide(
    fileEvent("glob", { pattern: join(OUTSIDE, "src", "**", "*.ts") }),
    interactions,
  );

  const request = interactions.requests[0];
  assert.ok(request);
  if (request.kind !== "external-directory") assert.fail("expected ask");
  assert.equal(request.targetPath, join(OUTSIDE, "src"));
  assert.equal(request.directory, join(OUTSIDE, "src"));
});

test("a glob without wildcards uses the whole pattern", async () => {
  const interactions = oneInteraction({ kind: "once" });

  await decide(fileEvent("glob", { pattern: join(OUTSIDE, "src") }), interactions);

  const request = interactions.requests[0];
  assert.ok(request);
  if (request.kind !== "external-directory") assert.fail("expected ask");
  assert.equal(request.targetPath, join(OUTSIDE, "src"));
});

test("always records the directory rule covering descendants but not siblings", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([{ kind: "always" }]);

  const first = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interactions,
    approved,
  );

  assert.deepEqual(first, { kind: "allow" });
  assert.deepEqual(approved, [{ kind: "directory", directory: OUTSIDE }]);

  const descendant = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "sub", "other.txt") }),
    interactions,
    approved,
  );
  assert.equal(interactions.requests.length, 1);
  assert.deepEqual(descendant, { kind: "allow" });

  const sibling = await decide(
    fileEvent("read_file", { path: join(CWD, "..", "outsidey", "x.txt") }),
    interactions,
    approved,
  );
  assert.equal(interactions.requests.length, 2);
  assert.deepEqual(sibling, { kind: "allow" });
});

test("approved directory rules do not match sibling prefixes", async () => {
  const approved: PermissionRule[] = [
    { kind: "directory", directory: PROJECT },
  ];
  const interactions = oneInteraction({ kind: "once" });

  const decision = await decide(
    fileEvent("read_file", { path: join(CWD, "..", "projectx", "main.ts") }),
    interactions,
    approved,
  );

  assert.equal(interactions.requests.length, 1);
  assert.deepEqual(decision, { kind: "allow" });
});

test("once allows the current call but records no directory", async () => {
  const interactions = new RecordingInteractions([{ kind: "once" }]);
  const approved: PermissionRule[] = [];

  const first = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interactions,
    approved,
  );

  assert.deepEqual(first, { kind: "allow" });
  assert.deepEqual(approved, []);

  const second = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interactions,
    approved,
  );
  assert.equal(interactions.requests.length, 2);
});

test("external-directory deny reasons flow verbatim", async () => {
  const interactions = oneInteraction({
    kind: "deny",
    reason: "读取工作区之外的文件需要确认",
  });

  const decision = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interactions,
  );

  assert.deepEqual(decision, {
    kind: "deny",
    reason: "读取工作区之外的文件需要确认",
  });
});

test("external-directory interaction failures and invalid replies close the door", async () => {
  const throwing: Interactions = {
    async permission(): Promise<PermissionReply> {
      throw new Error("adapter disconnected");
    },
  };
  const failed = await decide(
    fileEvent("read_file", { path: OUTSIDE }),
    throwing,
  );
  assert.deepEqual(failed, {
    kind: "deny",
    reason: "Permission request failed: adapter disconnected",
  });

  const invalidReply: Interactions = {
    async permission(): Promise<PermissionReply> {
      return { kind: "maybe" } as unknown as PermissionReply;
    },
  };
  const invalid = await decide(
    fileEvent("read_file", { path: OUTSIDE }),
    invalidReply,
  );
  assert.deepEqual(invalid, {
    kind: "deny",
    reason: "Permission request failed: invalid reply",
  });
});

test("a cancelled Run signal propagates for external directories too", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted");
  controller.abort(reason);
  const aborting: Interactions = {
    async permission(): Promise<PermissionReply> {
      throw reason;
    },
  };

  await assert.rejects(
    decide(
      fileEvent("read_file", { path: OUTSIDE }),
      aborting,
      [],
      CWD,
      controller.signal,
    ),
    (error: unknown) => error === reason,
  );
});

test("relative path targets resolve against the cwd", async () => {
  const interactions = oneInteraction({ kind: "once" });

  await decide(
    fileEvent("read_file", { path: "notes.txt" }),
    interactions,
    [],
    OUTSIDE,
  );

  const request = interactions.requests[0];
  assert.ok(request);
  if (request.kind !== "external-directory") assert.fail("expected ask");
  assert.equal(request.targetPath, join(OUTSIDE, "notes.txt"));
});

test("malformed path arguments are denied instead of falling back to the cwd", async () => {
  const interactions = new RecordingInteractions([]);

  const read = await decide(fileEvent("read_file", { path: 42 }), interactions);
  assert.deepEqual(read, {
    kind: "deny",
    reason: "Permission request failed: invalid arguments for read_file",
  });

  const glob = await decide(
    fileEvent("glob", { pattern: undefined }),
    interactions,
  );
  assert.deepEqual(glob, {
    kind: "deny",
    reason: "Permission request failed: invalid arguments for glob",
  });

  assert.equal(interactions.requests.length, 0);
});

test("tools unrelated to Permission pass through", async () => {
  const interactions = new RecordingInteractions([]);

  const decision = await decide(fileEvent("todo", {}), interactions);

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interactions.requests.length, 0);
});

// ── Bash 外部 cwd 与危险命令是两个连续分支 ──

test("bash authorizes external cwd before asking for a dangerous command", async () => {
  const approved: PermissionRule[] = [];
  const interactions = new RecordingInteractions([
    { kind: "always" },
    { kind: "once" },
  ]);

  const result = await decidePermission(bashEvent("rm file.txt"), {
    cwd: OUTSIDE,
    trustedDirectories: [PROJECT],
    approved,
    interactions,
  });

  assert.deepEqual(result, { kind: "allow" });
  assert.deepEqual(
    interactions.requests.map((request) => request.kind),
    ["external-directory", "dangerous-command"],
  );
  assert.deepEqual(approved, [
    { kind: "directory", directory: OUTSIDE },
  ]);
});

test("an external bash cwd denial stops before the command branch", async () => {
  const interactions = oneInteraction({
    kind: "deny",
    reason: "bash 必须在项目目录内运行",
  });

  const result = await decidePermission(bashEvent("echo hi"), {
    cwd: OUTSIDE,
    trustedDirectories: [PROJECT],
    approved: [],
    interactions,
  });

  assert.deepEqual(result, {
    kind: "deny",
    reason: "bash 必须在项目目录内运行",
  });
  assert.equal(interactions.requests.length, 1);
});
