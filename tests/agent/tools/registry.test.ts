import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { AgentTool, type AgentToolResult } from "../../../src/agent/tools/types.js";
import { AgentToolRegistry } from "../../../src/agent/tools/registry.js";

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

test("Registry registers, unregisters, and exports schemas", () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));
  registry.unregister("first");
  assert.deepEqual(registry.schemas().map((schema) => schema.name), ["second"]);
});

test("prepare returns ready for valid calls and execute does not revalidate", async () => {
  const registry = new AgentToolRegistry();
  const tool = new EchoTool();
  registry.register(tool);

  const ready = registry.prepare({
    type: "toolCall", id: "1", name: "echo", arguments: { value: "ok" },
  });
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") {
    assert.deepEqual(await registry.execute(ready.prepared), {
      content: "ok",
      isError: false,
    });
  }
  assert.equal(tool.validations.length, 1);
});

test("prepare rejects unknown tools", () => {
  const registry = new AgentToolRegistry();
  assert.deepEqual(
    registry.prepare({ type: "toolCall", id: "2", name: "missing", arguments: {} }),
    {
      kind: "rejected",
      reason: "unknown",
      result: { content: "Error: Unknown tool 'missing'", isError: true },
    },
  );
});

test("prepare rejects invalid arguments", () => {
  const registry = new AgentToolRegistry();
  registry.register(new EchoTool());

  const invalid = registry.prepare({
    type: "toolCall", id: "3", name: "echo", arguments: {},
  });
  assert.equal(invalid.kind, "rejected");
  if (invalid.kind === "rejected") assert.equal(invalid.reason, "invalid");
});

test("execute applies its global timeout", async () => {
  class HangingTool extends EchoTool {
    override async execute(): Promise<AgentToolResult> {
      return new Promise(() => undefined);
    }
  }
  const registry = new AgentToolRegistry(0.001);
  registry.register(new HangingTool());

  const ready = registry.prepare({
    type: "toolCall", id: "1", name: "echo", arguments: { value: "x" },
  });
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") {
    assert.equal((await registry.execute(ready.prepared)).isError, true);
  }
});

test("execute forwards a caller abort into the running tool", async () => {
  let received: AbortSignal | undefined;
  class SignalTool extends AgentTool<typeof parameters> {
    constructor() {
      super("echo", "Echo text.", parameters);
    }

    async execute(
      _arguments_: Static<typeof parameters>,
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      received = signal;
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

  const ready = registry.prepare({
    type: "toolCall", id: "1", name: "echo", arguments: { value: "x" },
  });
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") {
    const controller = new AbortController();
    const execution = registry.execute(ready.prepared, controller.signal);
    controller.abort();
    assert.equal((await execution).isError, true);
    assert.equal(received?.aborted, true);
  }
});
