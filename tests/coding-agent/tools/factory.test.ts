import assert from "node:assert/strict";
import test from "node:test";

import { AgentTool } from "../../../src/core/agent/tools/types.js";
import { createBuiltinToolRegistry } from "../../../src/coding-agent/tools/factory.js";

test("createBuiltinToolRegistry registers the six built-ins in order", () => {
  const first = createBuiltinToolRegistry(process.cwd());
  const second = createBuiltinToolRegistry(process.cwd());
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
