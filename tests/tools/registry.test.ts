import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static } from "typebox";

import { Tool } from "../../src/tools/base.js";
import { ToolExecutionError } from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const echoParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

class EchoTool extends Tool<typeof echoParameters> {
  constructor(name = "echo", timeout: number | null = null) {
    super(name, "Echo a value.", echoParameters, timeout);
  }

  async execute(arguments_: Static<typeof echoParameters>): Promise<string> {
    return arguments_.value;
  }
}

test("Registry exports schemas in registration order and unregisters", () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));

  assert.deepEqual(
    registry.schemas().map((schema) => schema.function.name),
    ["first", "second"],
  );
  registry.unregister("first");
  assert.deepEqual(
    registry.schemas().map((schema) => schema.function.name),
    ["second"],
  );
});

test("Registry rejects duplicate names", () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  assert.throws(() => registry.register(new EchoTool()), /already registered/);
});

test("Registry executes one ToolCall", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());

  assert.deepEqual(
    await registry.execute({
      id: "call-1",
      name: "echo",
      arguments: { value: "ok" },
    }),
    { content: "ok", isError: false },
  );
});

test("Registry returns errors for unknown tools", async () => {
  assert.deepEqual(
    await new ToolRegistry().execute({
      id: "missing-1",
      name: "missing",
      arguments: {},
    }),
    { content: "Error: Unknown tool 'missing'", isError: true },
  );
});

test("Registry validates model arguments without coercion", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());

  const result = await registry.execute({
    id: "call-1",
    name: "echo",
    arguments: { value: 7 },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: Invalid arguments/);
});

test("Registry passes the original argument object", async () => {
  const parameters = Type.Object(
    { value: Type.Number() },
    { additionalProperties: false },
  );
  let received: unknown;
  class CaptureTool extends Tool<typeof parameters> {
    constructor() {
      super("capture", "Capture input.", parameters);
    }
    async execute(arguments_: Static<typeof parameters>): Promise<string> {
      received = arguments_;
      return String(arguments_.value);
    }
  }
  const registry = new ToolRegistry();
  registry.register(new CaptureTool());
  const input = { value: 7 };

  assert.deepEqual(
    await registry.execute({ id: "call-1", name: "capture", arguments: input }),
    { content: "7", isError: false },
  );
  assert.equal(received, input);
});

test("Registry times out tools that do not settle", async () => {
  class HangingTool extends EchoTool {
    constructor() {
      super("hang", 0.001);
    }
    override async execute(): Promise<string> {
      return new Promise(() => undefined);
    }
  }
  const registry = new ToolRegistry();
  registry.register(new HangingTool());

  const result = await registry.execute({
    id: "call-1",
    name: "hang",
    arguments: { value: "x" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: Tool 'hang' timed out/);
});

test("Registry converts expected and unexpected tool failures", async () => {
  class ExpectedTool extends EchoTool {
    constructor() {
      super("expected");
    }
    override async execute(): Promise<string> {
      throw new ToolExecutionError("refused");
    }
  }
  class BrokenTool extends EchoTool {
    constructor() {
      super("broken");
    }
    override async execute(): Promise<string> {
      throw new Error("boom");
    }
  }
  const registry = new ToolRegistry();
  registry.register(new ExpectedTool());
  registry.register(new BrokenTool());

  assert.deepEqual(
    await registry.execute({ id: "c1", name: "expected", arguments: { value: "x" } }),
    { content: "Error: refused", isError: true },
  );
  assert.deepEqual(
    await registry.execute({ id: "c2", name: "broken", arguments: { value: "x" } }),
    { content: "Error: Tool 'broken' failed: boom", isError: true },
  );
});

test("Registry truncates successful and error results", async () => {
  const success = new ToolRegistry({ maxResultChars: 8 });
  success.register(new EchoTool());
  assert.deepEqual(
    await success.execute({
      id: "c1",
      name: "echo",
      arguments: { value: "abcdefghij" },
    }),
    { content: "abcdefgh", isError: false },
  );

  const error = await new ToolRegistry({ maxResultChars: 3 }).execute({
    id: "c2",
    name: "missing",
    arguments: {},
  });
  assert.deepEqual(error, { content: "Err", isError: true });
});
