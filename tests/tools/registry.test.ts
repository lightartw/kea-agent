import assert from "node:assert/strict";
import test from "node:test";

import { Type, type Static, type TSchema } from "typebox";

import { Tool } from "../../src/tools/base.js";
import {
  ToolConfigurationError,
  ToolExecutionError,
} from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const echoParameters = Type.Object(
  { value: Type.String() },
  { additionalProperties: false },
);

class EchoTool extends Tool<typeof echoParameters> {
  constructor(name = "echo", timeout: number | null = null) {
    super(name, "Echo a value.", echoParameters, timeout);
  }
  async execute(
    arguments_: Static<typeof echoParameters>,
  ): Promise<string> {
    return arguments_.value;
  }
}

class RawTool extends Tool<TSchema> {
  constructor(
    name: string,
    description: string,
    parameters: TSchema,
    timeout: number | null = null,
  ) {
    super(name, description, parameters, timeout);
  }
  async execute(): Promise<string> {
    return "ok";
  }
}

test("Registry preserves registration order and returns cloned schemas", () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool("first"));
  registry.register(new EchoTool("second"));

  assert.deepEqual(registry.names(), ["first", "second"]);
  assert.equal(registry.get("first")?.name, "first");
  const schemas = registry.schemas();
  assert.deepEqual(
    schemas.map((schema) => schema.function.name),
    ["first", "second"],
  );
  (schemas[0]!.function.parameters as any).changed = true;
  assert.equal((registry.schemas()[0]!.function.parameters as any).changed, undefined);
  registry.unregister("first");
  assert.deepEqual(registry.names(), ["second"]);
});

test("Registry rejects duplicates and malformed tool metadata", () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  assert.throws(() => registry.register(new EchoTool()), /already registered/);
  assert.throws(
    () => new ToolRegistry().register({} as never),
    /Tool instance/,
  );
  assert.throws(
    () => new ToolRegistry().register(new RawTool("", "description", echoParameters)),
    ToolConfigurationError,
  );
  assert.throws(
    () => new ToolRegistry().register(new RawTool("bad", "", echoParameters)),
    ToolConfigurationError,
  );
  assert.throws(
    () =>
      new ToolRegistry().register(
        new RawTool("bad", "bad schema", Type.String()),
      ),
    /root type must be object/,
  );
  assert.throws(
    () =>
      new ToolRegistry().register(
        new RawTool(
          "bad",
          "bad required",
          {
            type: "object",
            properties: {},
            required: ["missing"],
          } as TSchema,
        ),
      ),
    /required property is not declared: missing/,
  );
});

test("Registry validates timeout and result limit configuration", () => {
  for (const defaultTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new ToolRegistry({ defaultTimeout }),
      ToolConfigurationError,
    );
  }
  assert.throws(
    () => new ToolRegistry({ maxResultChars: 6 }),
    /at least 7/,
  );
  assert.throws(
    () => new ToolRegistry().register(new EchoTool("bad", Number.NaN)),
    /positive finite number/,
  );
  assert.throws(
    () => new ToolRegistry({ defaultTimeout: 2_147_483.648 }),
    /Node timer range/,
  );
  assert.doesNotThrow(() => new ToolRegistry({ defaultTimeout: 1.2345 }));
});

test("Registry returns errors for unknown tools and non-object arguments", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  assert.deepEqual(await registry.execute("missing", {}), {
    content: "Error: Unknown tool 'missing'",
    isError: true,
  });
  const result = await registry.execute("echo", []);
  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: arguments must be an object/);
});

test("Registry validates without coercion", async () => {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  const result = await registry.execute("echo", { value: 7 });
  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: Invalid arguments/);
});

test("Registry passes the original argument object and values", async () => {
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
  const result = await registry.execute("capture", input);

  assert.equal(received, input);
  assert.equal(typeof input.value, "number");
  assert.deepEqual(result, { content: "7", isError: false });
});

test("Registry times out tools even when they ignore cancellation", async () => {
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
  const result = await registry.execute("hang", { value: "x" });

  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: Tool 'hang' timed out/);
});

test("Registry lets caller cancellation escape unchanged", async () => {
  let executions = 0;
  class HangingTool extends EchoTool {
    override async execute(): Promise<string> {
      executions += 1;
      return new Promise(() => undefined);
    }
  }
  const registry = new ToolRegistry();
  registry.register(new HangingTool());
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);

  await assert.rejects(
    registry.execute("echo", { value: "x" }, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(executions, 0);
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

  assert.deepEqual(await registry.execute("expected", { value: "x" }), {
    content: "Error: refused",
    isError: true,
  });
  assert.deepEqual(await registry.execute("broken", { value: "x" }), {
    content: "Error: Tool 'broken' failed: boom",
    isError: true,
  });
});

test("Registry rejects non-string returns", async () => {
  class BadReturnTool extends EchoTool {
    override async execute(): Promise<string> {
      return 7 as never;
    }
  }
  const registry = new ToolRegistry();
  registry.register(new BadReturnTool());
  const result = await registry.execute("echo", { value: "x" });
  assert.deepEqual(result, {
    content: "Error: Tool 'echo' must return a string",
    isError: true,
  });
});

test("Registry truncates successful and error results", async () => {
  const success = new ToolRegistry({ maxResultChars: 8 });
  success.register(new EchoTool());
  assert.deepEqual(await success.execute("echo", { value: "abcdefghij" }), {
    content: "abcdefgh",
    isError: false,
  });

  const errors = new ToolRegistry({ maxResultChars: 7 });
  const result = await errors.execute("missing", {});
  assert.deepEqual(result, { content: "Error: ", isError: true });
});
