import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { AgentTool } from "../../../src/core/harness/tools/types.js";
import { HarnessHooks } from "../../../src/core/harness/events.js";
import { createBuiltinToolRegistry } from "../../../src/coding-agent/tools/factory.js";

test("createBuiltinToolRegistry registers the six built-ins in order", () => {
  const first = createBuiltinToolRegistry(process.cwd(), 120);
  const second = createBuiltinToolRegistry(process.cwd(), 120);
  assert.deepEqual(
    first.all().map((tool) => tool.name),
    ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write"],
  );
  assert.notEqual(first, second);
  for (let index = 0; index < first.all().length; index += 1) {
    assert.notEqual(first.all()[index], second.all()[index]);
    assert.ok(first.all()[index] instanceof AgentTool);
  }
  assert.equal(
    first.all().find((tool) => tool.name === "bash")?.validate({ command: "pwd" }),
    undefined,
  );
  assert.ok(first.all().find((tool) => tool.name === "read_file")?.validate({ path: 1 }));
});

test("the registry timeout applies to tool execution", async () => {
  const registry = createBuiltinToolRegistry(process.cwd(), 0.001);
  registry.register(new (class extends AgentTool {
    constructor() {
      super("slow", "slow", Type.Object({}));
    }
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { content: "ok", isError: false };
    }
  })());

  const result = await registry.execute(
    { type: "toolCall", id: "c1", name: "slow", arguments: {} },
    { sessionId: "s", runId: "r", cwd: process.cwd(), hooks: new HarnessHooks() },
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /timed out/i);
});
