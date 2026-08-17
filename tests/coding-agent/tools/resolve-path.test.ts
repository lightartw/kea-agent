import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveToolPath } from "../../../src/coding-agent/tools/resolve-path.js";

test("resolveToolPath resolves relative, parent, and absolute input without policy", () => {
  const cwd = resolve("C:/work/project/src");
  assert.equal(resolveToolPath(cwd, "index.ts"), join(cwd, "index.ts"));
  assert.equal(resolveToolPath(cwd, "../README.md"), resolve(cwd, "../README.md"));
  const outside = resolve("C:/outside/file.txt");
  assert.equal(resolveToolPath(cwd, outside), outside);
});
