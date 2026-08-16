import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { AgentTool, type AgentToolResult } from "../../../src/core/agent/tools/types.js";
import { AgentToolRegistry } from "../../../src/core/agent/tools/registry.js";
import { Events } from "../../../src/core/events/events.js";

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

  const result = await registry.execute(echoCall(), new Events());

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.equal(tool.validations.length, 1);
});

test("execute rejects unknown tools", async () => {
  const registry = new AgentToolRegistry();
  const result = await registry.execute(
    echoCall({ name: "missing" }),
    new Events(),
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
    new Events(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /Invalid arguments for tool 'echo'/);
});

test("execute runs tools/pre-execute then lookup then execute", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);
  const events = new Events();
  const stages: string[] = [];
  events.on("tools/pre-execute", (call, proceed) => {
    stages.push("pre-execute");
    return proceed({ ...call, arguments: { value: "changed" } });
  });
  events.on("tools/execute", (call, proceed) => {
    stages.push(`execute:${(call.arguments as { value: string }).value}`);
    return proceed(call);
  });
  events.on("tools/post-execute", (input, proceed) => {
    stages.push("post-execute");
    return proceed(input);
  });

  const result = await registry.execute(echoCall(), events);

  assert.deepEqual(result, { content: "ok", isError: false });
  assert.deepEqual(stages, [
    "pre-execute",
    "execute:ok",
    "post-execute",
  ]);
});

test("execute returns a pre-execute block result without running the tool", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);
  const events = new Events();
  events.on("tools/pre-execute", () => ({
    kind: "deny",
    reason: "blocked",
  }));

  const result = await registry.execute(echoCall(), events);

  assert.deepEqual(result, { content: "Error: blocked", isError: true });
  assert.equal(tool.validations.length, 0);
});

test("execute applies its global timeout", async () => {
  class HangingTool extends EchoTool {
    override async execute(): Promise<AgentToolResult> {
      return new Promise(() => undefined);
    }
  }
  const registry = new AgentToolRegistry(0.001);
  registry.register(new HangingTool());

  assert.equal((await registry.execute(echoCall(), new Events())).isError, true);
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
  const execution = registry.execute(echoCall(), new Events(), controller.signal);
  await startedPromise;
  controller.abort();
  assert.equal((await execution).isError, true);
  assert.equal(received?.aborted, true);
});

test("a failing Tool interceptor becomes this call's error result", async () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());
  const events = new Events();
  events.on("tools/execute", () => {
    throw new Error("tool pipeline failed");
  });

  const result = await registry.execute(echoCall(), events);

  assert.equal(result.isError, true);
  assert.match(result.content, /tool pipeline failed/);
});
