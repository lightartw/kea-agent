import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { parseArguments } from "../../src/application/arguments.js";

test("defaults when no arguments are given", () => {
  assert.deepEqual(parseArguments([]), {
    command: "run",
    continue: false,
    verbose: false,
    directory: process.cwd(),
  });
});

test("run arguments parse continue, override, verbose, and directory", () => {
  assert.deepEqual(
    parseArguments(["-c", "--config", "custom.json", "--verbose", "work"]),
    {
      command: "run",
      continue: true,
      config: resolve("custom.json"),
      verbose: true,
      directory: resolve("work"),
    },
  );
});

test("a single positional directory resolves against the cwd", () => {
  assert.deepEqual(parseArguments(["work"]), {
    command: "run",
    continue: false,
    verbose: false,
    directory: resolve("work"),
  });
});

test("init parses alone", () => {
  assert.deepEqual(parseArguments(["init"]), { command: "init" });
});

test("init rejects unrelated arguments", () => {
  assert.throws(
    () => parseArguments(["init", "--config", "x.json"]),
    /init.*does not accept/i,
  );
});

test("unknown options and a missing option value fail", () => {
  assert.throws(
    () => parseArguments(["--unknown"]),
    /unknown option.*--unknown/i,
  );
  assert.throws(
    () => parseArguments(["--config"]),
    /--config.*value|missing.*--config/i,
  );
});

test("duplicate single-value options fail", () => {
  assert.throws(
    () => parseArguments(["--config", "a.json", "--config", "b.json"]),
    /duplicate.*--config/i,
  );
  assert.throws(() => parseArguments(["-c", "-c"]), /duplicate.*-c/i);
  assert.throws(
    () => parseArguments(["--verbose", "--verbose"]),
    /duplicate.*--verbose/i,
  );
});

test("multiple directories fail", () => {
  assert.throws(
    () => parseArguments(["a", "b"]),
    /multiple directories/i,
  );
});
