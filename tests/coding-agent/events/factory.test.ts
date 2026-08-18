import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";

import { Events } from "../../../src/core/events/events.js";
import {
  AgentTool,
  type AgentToolCall,
  type AgentToolResult,
} from "../../../src/core/harness/tools/types.js";
import { AgentToolRegistry } from "../../../src/core/harness/tools/registry.js";
import { createBuiltinEvents } from "../../../src/coding-agent/events/factory.js";
import type { PermissionRule } from "../../../src/coding-agent/events/permission/permission.js";
import {
  type Interactions,
  type PermissionReply,
  type PermissionRequest,
} from "../../../src/coding-agent/interaction/interactions.js";

const PROJECT = resolve(join("work", "project"));
const OUTSIDE = resolve(join("work", "outside"));

const bashParameters = Type.Object({ command: Type.String() });
const pathParameters = Type.Object({ path: Type.String() });

class BashTool extends AgentTool<typeof bashParameters> {
  readonly calls: string[] = [];

  constructor() {
    super("bash", "Run a command.", bashParameters);
  }

  async execute(
    arguments_: Static<typeof bashParameters>,
  ): Promise<AgentToolResult> {
    this.calls.push(arguments_.command);
    return { content: "ok", isError: false };
  }
}

class ReadFileTool extends AgentTool<typeof pathParameters> {
  readonly calls: string[] = [];

  constructor() {
    super("read_file", "Read a file.", pathParameters);
  }

  async execute(
    arguments_: Static<typeof pathParameters>,
  ): Promise<AgentToolResult> {
    this.calls.push(arguments_.path);
    return { content: "ok", isError: false };
  }
}

function bashCall(command: string): AgentToolCall {
  return {
    type: "toolCall",
    id: "c1",
    name: "bash",
    arguments: { command },
  };
}

function readCall(path: string): AgentToolCall {
  return {
    type: "toolCall",
    id: "c1",
    name: "read_file",
    arguments: { path },
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

function harness(
  interactions: Interactions,
  onListenerError?: (error: unknown, name: string, input: unknown) => void,
) {
  const registry = new AgentToolRegistry();
  const bashTool = new BashTool();
  const readFileTool = new ReadFileTool();
  registry.register(bashTool);
  registry.register(readFileTool);
  const approved: PermissionRule[] = [];
  const events = createBuiltinEvents({
    interactions,
    approved,
    trustedDirectories: [PROJECT],
    ...(onListenerError === undefined ? {} : { onListenerError }),
  });
  return {
    events,
    registry,
    approved,
    bashTool,
    readFileTool,
    execute(call: AgentToolCall, sessionId = "session-a", cwd = PROJECT) {
      return registry.execute(call, {
        sessionId,
        runId: "run-1",
        cwd,
        events,
      });
    },
  };
}

test("safe Bash commands reach the Tool without an interaction", async () => {
  const interactions = new RecordingInteractions([]);
  const h = harness(interactions);

  const result = await h.execute(bashCall("echo hello"));

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.deepEqual(h.bashTool.calls, ["echo hello"]);
  assert.equal(interactions.requests.length, 0);
});

test("hard deny stops later listeners and the Tool", async () => {
  const h = harness(new RecordingInteractions([]));
  const chain: string[] = [];
  h.events.on("tools/pre-execute", (input, proceed) => {
    chain.push("after-permission");
    return proceed(input);
  });

  const result = await h.execute(bashCall("sudo true"));

  assert.deepEqual(chain, []);
  assert.equal(h.bashTool.calls.length, 0);
  assert.deepEqual(result, {
    content: "Error: sudo is not allowed",
    isError: true,
  });
});

test("an always approval in one session is reused by another", async () => {
  const interactions = new RecordingInteractions([{ kind: "always" }]);
  const h = harness(interactions);

  const first = await h.execute(bashCall("rm file.txt"), "session-a");
  assert.deepEqual(first, { content: "ok", isError: false });

  const second = await h.execute(bashCall("rm file.txt"), "session-b");
  assert.deepEqual(second, { content: "ok", isError: false });

  assert.equal(interactions.requests.length, 1);
  assert.deepEqual(h.approved, [
    { kind: "command", command: "rm file.txt", cwd: PROJECT },
  ]);
  assert.deepEqual(h.bashTool.calls, ["rm file.txt", "rm file.txt"]);
});

test("paths outside the trusted directories ask and proceed once", async () => {
  const interactions = new RecordingInteractions([{ kind: "once" }]);
  const h = harness(interactions);

  const result = await h.execute(readCall(join(OUTSIDE, "data.txt")));

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.deepEqual(h.readFileTool.calls, [join(OUTSIDE, "data.txt")]);
  assert.equal(interactions.requests.length, 1);
  const request = interactions.requests[0];
  assert.ok(request);
  assert.equal(request.kind, "external-directory");
  if (request.kind !== "external-directory") return;
  assert.equal(request.sessionId, "session-a");
  assert.equal(request.targetPath, join(OUTSIDE, "data.txt"));
});

test("onListenerError is forwarded to the Events bus", async () => {
  const reported: unknown[] = [];
  const h = harness(new RecordingInteractions([]), (error, name, input) => {
    reported.push(error, name, input);
  });
  const boom = new Error("boom");
  h.events.on("harness/run-start", () => {
    throw boom;
  });

  await h.events.emit("harness/run-start", {
    sessionId: "session-a",
    runId: "run-1",
  });

  assert.deepEqual(reported, [
    boom,
    "harness/run-start",
    { sessionId: "session-a", runId: "run-1" },
  ]);
});
