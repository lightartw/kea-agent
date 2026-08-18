import assert from "node:assert/strict";
import test from "node:test";

import { parseInput } from "../../src/ui/commands.js";

test("only exact registered tokens at character zero are commands", () => {
  assert.deepEqual(parseInput("/new"), { kind: "new-session" });
  assert.deepEqual(parseInput("/session"), { kind: "switch-session" });
  assert.deepEqual(parseInput("/model"), { kind: "switch-model" });
  assert.deepEqual(parseInput("/help"), { kind: "help" });
  assert.deepEqual(parseInput("/exit"), { kind: "exit" });
  assert.deepEqual(parseInput("/unknown"), { kind: "prompt", text: "/unknown" });
  assert.deepEqual(parseInput(" /new"), { kind: "prompt", text: " /new" });
  assert.deepEqual(parseInput("read /tmp/a"), { kind: "prompt", text: "read /tmp/a" });
  assert.deepEqual(parseInput("/new extra"), {
    kind: "command-error",
    message: "/new does not accept arguments",
  });
  assert.deepEqual(parseInput("/exit now"), {
    kind: "command-error",
    message: "/exit does not accept arguments",
  });
});

test("Prompt text is never trimmed", () => {
  assert.deepEqual(parseInput("  hello  "), { kind: "prompt", text: "  hello  " });
  assert.deepEqual(parseInput("/unknown "), { kind: "prompt", text: "/unknown " });
});
