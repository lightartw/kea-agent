import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultToolDefinitions } from "../../../src/coding-agent/tools/factory.js";

test("createDefaultToolDefinitions installs built-in tools", () => {
  assert.deepEqual(
    createDefaultToolDefinitions().map((definition) => definition.name),
    ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write"],
  );
});
