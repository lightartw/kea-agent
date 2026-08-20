import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import {
  AgentTool,
  type AgentToolCall,
  type AgentToolResult,
  type ToolExecutionContext,
} from "../../../src/core/harness/tools/types.js";
import { AgentToolRegistry } from "../../../src/core/harness/tools/registry.js";
import { HarnessHooks } from "../../../src/core/harness/events.js";

const parameters = Type.Object({ value: Type.String() });

class EchoTool extends AgentTool<typeof parameters> {
  readonly validations: unknown[] = [];

  constructor(name = "echo") {
    super(name, "Echo text.", parameters);
  }

  override validate(arguments_: unknown): string | undefined {
    this.validations.push(arguments_);
    return super.validate(arguments_);
  }

  async execute(arguments_: Static<typeof parameters>): Promise<AgentToolResult> {
    return { content: arguments_.value, isError: false };
  }
}

function echoCall(overrides: Partial<{ id: string; name: string; arguments: Record<string, unknown> }> = {}) {
  return {
    type: "toolCall" as const,
    id: "1",
    name: "echo",
    arguments: { value: "ok" },
    ...overrides,
  };
}

function contextFor(
  hooks = new HarnessHooks(),
  signal?: AbortSignal,
): ToolExecutionContext {
  return {
    sessionId: "session-1",
    runId: "run-1",
    cwd: process.cwd(),
    hooks,
    ...(signal === undefined ? {} : { signal }),
  };
}

test("Registry registers, unregisters, and exports schemas", () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));
  registry.unregister("first");
  assert.deepEqual(registry.schemas().map((schema) => schema.name), ["second"]);
});

test("execute runs lookup, validation, and the tool body", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);

  const result = await registry.execute(echoCall(), contextFor());

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.equal(tool.validations.length, 1);
});

test("execute rejects unknown tools", async () => {
  const registry = new AgentToolRegistry();
  const result = await registry.execute(
    echoCall({ name: "missing" }),
    contextFor(),
  );
  assert.deepEqual(result, {
    content: "Error: Unknown tool 'missing'",
    isError: true,
  });
});

test("execute rejects invalid arguments", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());

  const result = await registry.execute(
    echoCall({ arguments: {} }),
    contextFor(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /Invalid arguments for tool 'echo'/);
});

test("execute allows by default when no beforeTool handler is registered", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());

  const result = await registry.execute(echoCall(), contextFor());

  assert.deepEqual(result, { content: "ok", isError: false });
});

test("a beforeTool deny blocks execution without running the tool body", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);
  const hooks = new HarnessHooks();
  hooks.on("beforeTool", () => ({ kind: "deny", reason: "blocked" }));

  const result = await registry.execute(echoCall(), contextFor(hooks));

  assert.deepEqual(result, { content: "Error: blocked", isError: true });
  assert.equal(tool.validations.length, 1);
});

test("multiple beforeTool handlers stop at the first deny", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());
  const hooks = new HarnessHooks();
  const order: string[] = [];
  hooks.on("beforeTool", () => {
    order.push("a");
    return { kind: "deny", reason: "no" };
  });
  hooks.on("beforeTool", () => {
    order.push("b");
    return { kind: "allow" };
  });

  const result = await registry.execute(echoCall(), contextFor(hooks));

  assert.deepEqual(result, { content: "Error: no", isError: true });
  assert.deepEqual(order, ["a"]);
});

test("beforeTool receives the call, run identity, and signal", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());
  const hooks = new HarnessHooks();
  const controller = new AbortController();
  let seen:
    | { call: AgentToolCall; sessionId: string; runId: string; signal: AbortSignal | undefined }
    | undefined;
  hooks.on("beforeTool", (input, ctx) => {
    seen = {
      call: input.call,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      signal: ctx.signal,
    };
  });

  await registry.execute(echoCall(), contextFor(hooks, controller.signal));

  assert.equal(seen?.call.name, "echo");
  assert.equal(seen?.sessionId, "session-1");
  assert.equal(seen?.runId, "run-1");
  assert.equal(seen?.signal, controller.signal);
});

test("execute applies its global timeout", async () => {
  class HangingTool extends EchoTool {
    override async execute(): Promise<AgentToolResult> {
      return new Promise(() => undefined);
    }
  }
  const registry = new AgentToolRegistry(0.001);
  registry.register(new HangingTool());

  assert.equal((await registry.execute(echoCall(), contextFor())).isError, true);
});

test("execute forwards a caller abort into the running tool", async () => {
  let received: AbortSignal | undefined;
  let started: () => void = () => undefined;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  class SignalTool extends AgentTool<typeof parameters> {
    constructor() {
      super("echo", "Echo text.", parameters);
    }

    async execute(
      _arguments_: Static<typeof parameters>,
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      received = signal;
      started();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }
  }
  const registry = new AgentToolRegistry(120);
  registry.register(new SignalTool());

  const controller = new AbortController();
  const execution = registry.execute(
    echoCall(),
    contextFor(new HarnessHooks(), controller.signal),
  );
  await startedPromise;
  controller.abort();
  assert.equal((await execution).isError, true);
  assert.equal(received?.aborted, true);
});
