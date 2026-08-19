import assert from "node:assert/strict";
import test from "node:test";

import type {
  InteractionOptions,
  UserInteraction,
} from "../../../src/coding-agent/interaction/interactions.js";

test("UserInteraction is a UI-independent port whose shape is stable", async () => {
  const adapter: UserInteraction = {
    async select(_title, options, opts?: InteractionOptions) {
      opts?.signal?.throwIfAborted();
      return options.length - 1;
    },
    async confirm(_title, _message, opts?: InteractionOptions) {
      opts?.signal?.throwIfAborted();
      return false;
    },
    async input(_title, _placeholder, opts?: InteractionOptions) {
      opts?.signal?.throwIfAborted();
      return "text";
    },
  };

  assert.equal(await adapter.select("title", ["a", "b", "c"]), 2);
  assert.equal(await adapter.confirm("title", "message"), false);
  assert.equal(await adapter.input("title", undefined), "text");
});

test("select returns undefined on cancel and propagates a genuine abort", async () => {
  const cancelled: UserInteraction = {
    async select() {
      return undefined;
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
  };
  assert.equal(await cancelled.select("t", ["a"]), undefined);

  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  const aborted: UserInteraction = {
    async select(_title, _options, opts?: InteractionOptions) {
      opts?.signal?.throwIfAborted();
      return 0;
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
  };
  await assert.rejects(
    aborted.select("t", ["a"], { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
});
