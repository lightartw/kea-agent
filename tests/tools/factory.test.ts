import assert from "node:assert/strict";
import test from "node:test";

import { createToolRegistry } from "../../src/tools/factory.js";

test("createToolRegistry installs Bash", () => {
  const registry = createToolRegistry(process.cwd());
  assert.deepEqual(
    registry.schemas().map((schema) => schema.function.name),
    ["bash"],
  );
});
