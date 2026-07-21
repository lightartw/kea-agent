import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../../src/tools/factory.js";

test("createToolRegistry installs Bash", () => {
  assert.deepEqual(
    createToolRegistry(process.cwd()).schemas().map((schema) => schema.function.name),
    ["bash"],
  );
});
