import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";

import type {
  AgentToolCall,
} from "../../../../src/core/harness/tools/types.js";
import type { ToolCallEvent } from "../../../../src/core/harness/tools/events.js";
import type {
  InteractionOptions,
  UserInteraction,
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

type SelectRecord = { readonly title: string; readonly options: readonly string[] };

/** Interaction stub recording select calls and returning preset indexes in order. */
class RecordingInteractions implements UserInteraction {
  readonly selects: SelectRecord[] = [];

  constructor(private readonly indexes: (number | undefined)[]) {}

  async select(
    title: string,
    options: readonly string[],
    _opts?: InteractionOptions,
  ): Promise<number | undefined> {
    this.selects.push({ title, options });
    if (this.indexes.length === 0) return 0;
    return this.indexes.shift();
  }

  async confirm(): Promise<boolean> {
    throw new Error("confirm not used");
  }

  async input(): Promise<string | undefined> {
    throw new Error("input not used");
  }
}

function decide(
  input: ToolCallEvent,
  interaction: UserInteraction,
  approved: PermissionRule[] = [],
  cwd = CWD,
  signal?: AbortSignal,
) {
  return decidePermission(
    input,
    { cwd, trustedDirectories: [PROJECT], approved, interaction },
    signal,
  );
}

type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };

/** Maps a semantic reply to the index the generalized select expects. */
function replyIndex(reply: PermissionReply): number | undefined {
  switch (reply.kind) {
    case "once":
      return 0;
    case "always":
      return 1;
    default:
      return undefined;
  }
}

function oneInteraction(reply: PermissionReply): RecordingInteractions {
  return new RecordingInteractions([replyIndex(reply)]);
}

// ── Bash 策略与回答（spec §12）──

test("ordinary Bash commands proceed without an interaction", async () => {
  const interaction = new RecordingInteractions([]);

  const decision = await decide(bashEvent("echo hello"), interaction);

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interaction.selects.length, 0);
});

test("hard deny uses the policy reason and never asks", async () => {
  const interaction = new RecordingInteractions([]);

  const decision = await decide(bashEvent("sudo true"), interaction);

  assert.deepEqual(decision, { kind: "deny", reason: "sudo is not allowed" });
  assert.equal(interaction.selects.length, 0);
});

test("once allows the current call but records no rule", async () => {
  const interaction = new RecordingInteractions([0]);
  const approved: PermissionRule[] = [];

  const first = await decide(bashEvent("rm file.txt"), interaction, approved);

  assert.deepEqual(first, { kind: "allow" });
  assert.deepEqual(approved, []);

  const second = await decide(bashEvent("rm file.txt"), interaction, approved);
  assert.equal(interaction.selects.length, 2);
  assert.deepEqual(second, { kind: "allow" });
});

test("always appends a command rule to the supplied approved array", async () => {
  const approved: PermissionRule[] = [];
  const interaction = new RecordingInteractions([1]);

  assert.deepEqual(
    await decide(bashEvent("rm file.txt"), interaction, approved),
    { kind: "allow" },
  );
  assert.deepEqual(approved, [
    { kind: "command", command: "rm file.txt", cwd: CWD },
  ]);

  await decide(bashEvent("rm file.txt"), interaction, approved);
  assert.equal(interaction.selects.length, 1);
});

test("approved rules are reusable by another session in one project", async () => {
  const approved: PermissionRule[] = [];
  const interaction = new RecordingInteractions([1]);

  await decide(bashEvent("rm file.txt", "session-a"), interaction, approved);
  await decide(bashEvent("rm file.txt", "session-b"), interaction, approved);

  assert.equal(interaction.selects.length, 1);
});

test("hard deny overrides a remembered allow", async () => {
  const approved: PermissionRule[] = [
    { kind: "command", command: "sudo true", cwd: CWD },
  ];
  const interaction = new RecordingInteractions([]);

  const decision = await decide(bashEvent("sudo true"), interaction, approved);

  assert.deepEqual(decision, { kind: "deny", reason: "sudo is not allowed" });
  assert.equal(interaction.selects.length, 0);
});

test("interaction failures and invalid replies close the door", async () => {
  const throwing: UserInteraction = {
    async select(): Promise<number | undefined> {
      throw new Error("adapter disconnected");
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
  };
  const failed = await decide(bashEvent("rm file.txt"), throwing);
  assert.deepEqual(failed, {
    kind: "deny",
    reason: "Permission request failed: adapter disconnected",
  });

  const invalidReply = new RecordingInteractions([99]);
  const invalid = await decide(bashEvent("rm file.txt"), invalidReply);
  assert.deepEqual(invalid, {
    kind: "deny",
    reason: "Permission denied by user",
  });
});

test("a cancelled Run signal propagates instead of a user denial", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted");
  controller.abort(reason);
  const aborting: UserInteraction = {
    async select(): Promise<number | undefined> {
      throw reason;
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
  };

  await assert.rejects(
    decide(bashEvent("rm file.txt"), aborting, [], CWD, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("malformed Bash arguments are denied without asking", async () => {
  const interaction = new RecordingInteractions([]);

  const decision = await decide(
    fileEvent("bash", { command: 42 }),
    interaction,
  );

  assert.deepEqual(decision, {
    kind: "deny",
    reason: "Permission request failed: invalid arguments for bash",
  });
  assert.equal(interaction.selects.length, 0);
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
      interaction: new RecordingInteractions([]),
    },
  );

  assert.deepEqual(result, { kind: "allow" });
  assert.deepEqual(approved, []);
});

test("a path outside the trusted directories asks with the target in the prompt", async () => {
  const interaction = oneInteraction({ kind: "once" });

  const decision = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interaction,
  );

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interaction.selects.length, 1);
  assert.match(interaction.selects[0]!.title, /outside the project directory/);
  assert.match(interaction.selects[0]!.title, /data\.txt/);
});

test("every path tool asks for targets outside the trusted directories", async () => {
  const tools = ["read_file", "write_file", "edit_file", "glob"] as const;
  for (const name of tools) {
    const interaction = oneInteraction({ kind: "once" });

    const decision = await decide(
      fileEvent(name, {
        ...(name === "glob"
          ? { pattern: join(OUTSIDE, "src", "*.ts") }
          : { path: join(OUTSIDE, "data.txt") }),
      }),
      interaction,
    );

    assert.deepEqual(decision, { kind: "allow" }, name);
    assert.equal(interaction.selects.length, 1, name);
  }
});

test("glob targets use the static prefix before the first wildcard", async () => {
  const interaction = oneInteraction({ kind: "once" });

  await decide(
    fileEvent("glob", { pattern: join(OUTSIDE, "src", "**", "*.ts") }),
    interaction,
  );

  assert.equal(interaction.selects.length, 1);
  assert.match(interaction.selects[0]!.title, /src/);
});

test("a glob without wildcards uses the whole pattern", async () => {
  const interaction = oneInteraction({ kind: "once" });

  await decide(fileEvent("glob", { pattern: join(OUTSIDE, "src") }), interaction);

  assert.equal(interaction.selects.length, 1);
  assert.match(interaction.selects[0]!.title, /src/);
});

test("always records the directory rule covering descendants but not siblings", async () => {
  const approved: PermissionRule[] = [];
  const interaction = new RecordingInteractions([1]);

  const first = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interaction,
    approved,
  );

  assert.deepEqual(first, { kind: "allow" });
  assert.deepEqual(approved, [{ kind: "directory", directory: OUTSIDE }]);

  const descendant = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "sub", "other.txt") }),
    interaction,
    approved,
  );
  assert.equal(interaction.selects.length, 1);
  assert.deepEqual(descendant, { kind: "allow" });

  const sibling = await decide(
    fileEvent("read_file", { path: join(CWD, "..", "outsidey", "x.txt") }),
    interaction,
    approved,
  );
  assert.equal(interaction.selects.length, 2);
  assert.deepEqual(sibling, { kind: "allow" });
});

test("approved directory rules do not match sibling prefixes", async () => {
  const approved: PermissionRule[] = [
    { kind: "directory", directory: PROJECT },
  ];
  const interaction = oneInteraction({ kind: "once" });

  const decision = await decide(
    fileEvent("read_file", { path: join(CWD, "..", "projectx", "main.ts") }),
    interaction,
    approved,
  );

  assert.equal(interaction.selects.length, 1);
  assert.deepEqual(decision, { kind: "allow" });
});

test("once allows the current call but records no directory", async () => {
  const interaction = new RecordingInteractions([0]);
  const approved: PermissionRule[] = [];

  const first = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interaction,
    approved,
  );

  assert.deepEqual(first, { kind: "allow" });
  assert.deepEqual(approved, []);

  const second = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interaction,
    approved,
  );
  assert.equal(interaction.selects.length, 2);
});

test("a plain external-directory denial returns deny", async () => {
  const interaction = oneInteraction({ kind: "deny" });

  const decision = await decide(
    fileEvent("read_file", { path: join(OUTSIDE, "data.txt") }),
    interaction,
  );

  assert.deepEqual(decision, {
    kind: "deny",
    reason: "Permission denied by user",
  });
  assert.equal(interaction.selects.length, 1);
});

test("external-directory interaction failures and invalid replies close the door", async () => {
  const throwing: UserInteraction = {
    async select(): Promise<number | undefined> {
      throw new Error("adapter disconnected");
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
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

  const invalidReply = new RecordingInteractions([99]);
  const invalid = await decide(
    fileEvent("read_file", { path: OUTSIDE }),
    invalidReply,
  );
  assert.deepEqual(invalid, {
    kind: "deny",
    reason: "Permission denied by user",
  });
});

test("a cancelled Run signal propagates for external directories too", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted");
  controller.abort(reason);
  const aborting: UserInteraction = {
    async select(): Promise<number | undefined> {
      throw reason;
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
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
  const interaction = oneInteraction({ kind: "once" });

  await decide(
    fileEvent("read_file", { path: "notes.txt" }),
    interaction,
    [],
    OUTSIDE,
  );

  assert.equal(interaction.selects.length, 1);
  assert.match(interaction.selects[0]!.title, /notes\.txt/);
});

test("malformed path arguments are denied instead of falling back to the cwd", async () => {
  const interaction = new RecordingInteractions([]);

  const read = await decide(fileEvent("read_file", { path: 42 }), interaction);
  assert.deepEqual(read, {
    kind: "deny",
    reason: "Permission request failed: invalid arguments for read_file",
  });

  const glob = await decide(
    fileEvent("glob", { pattern: undefined }),
    interaction,
  );
  assert.deepEqual(glob, {
    kind: "deny",
    reason: "Permission request failed: invalid arguments for glob",
  });

  assert.equal(interaction.selects.length, 0);
});

test("tools unrelated to Permission pass through", async () => {
  const interaction = new RecordingInteractions([]);

  const decision = await decide(fileEvent("todo", {}), interaction);

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(interaction.selects.length, 0);
});

// ── Bash 外部 cwd 与危险命令是两个连续分支 ──

test("bash authorizes external cwd before asking for a dangerous command", async () => {
  const approved: PermissionRule[] = [];
  const interaction = new RecordingInteractions([1, 0]);

  const result = await decidePermission(bashEvent("rm file.txt"), {
    cwd: OUTSIDE,
    trustedDirectories: [PROJECT],
    approved,
    interaction,
  });

  assert.deepEqual(result, { kind: "allow" });
  assert.equal(interaction.selects.length, 2);
  assert.deepEqual(approved, [
    { kind: "directory", directory: OUTSIDE },
  ]);
});

test("an external bash cwd denial stops before the command branch", async () => {
  const interaction = oneInteraction({ kind: "deny" });

  const result = await decidePermission(bashEvent("echo hi"), {
    cwd: OUTSIDE,
    trustedDirectories: [PROJECT],
    approved: [],
    interaction,
  });

  assert.deepEqual(result, {
    kind: "deny",
    reason: "Permission denied by user",
  });
  assert.equal(interaction.selects.length, 1);
});
