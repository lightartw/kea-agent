import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../../src/tools/factory.js";

test("createToolRegistry installs built-in tools", () => {
  assert.deepEqual(
    createToolRegistry(process.cwd()).schemas().map((schema) => schema.function.name),
    ["bash", "read_file", "write_file", "edit_file", "glob"],
  );
});
