import assert from "node:assert/strict";
import test from "node:test";

import { CliInteractions } from "../../../src/ui/cli/cli-interactions.js";

function interactionsWithAnswers(
  answers: readonly string[],
): { readonly interactions: CliInteractions; readonly prompts: string[] } {
  const prompts: string[] = [];
  const queue = [...answers];
  const interactions = new CliInteractions({
    question: async (prompt) => {
      prompts.push(prompt);
      return queue.shift() ?? "";
    },
  });
  return { interactions, prompts };
}

test("select parses 1-based answers into 0-based indexes and undefined on invalid", async () => {
  const { interactions, prompts } = interactionsWithAnswers([
    "1", "2", "3", "", "garbage", "99",
  ]);
  const options = ["Allow once", "Always allow", "Deny"];

  assert.equal(await interactions.select("Allow?", options), 0);
  assert.equal(await interactions.select("Allow?", options), 1);
  assert.equal(await interactions.select("Allow?", options), 2);
  assert.equal(await interactions.select("Allow?", options), undefined);
  assert.equal(await interactions.select("Allow?", options), undefined);
  assert.equal(await interactions.select("Allow?", options), undefined);

  assert.equal(prompts.length, 6);
  assert.ok(prompts[0]!.includes("Allow once"), prompts[0]);
  assert.ok(prompts[0]!.includes("Always allow"), prompts[0]);
  assert.ok(prompts[0]!.includes("Deny"), prompts[0]);
  assert.ok(prompts[0]!.includes("Allow?"), prompts[0]);
});

test("confirm treats y/yes as true and everything else as false", async () => {
  const { interactions } = interactionsWithAnswers(["y", "yes", "n", ""]);
  assert.equal(await interactions.confirm("t", "Proceed?"), true);
  assert.equal(await interactions.confirm("t", "Proceed?"), true);
  assert.equal(await interactions.confirm("t", "Proceed?"), false);
  assert.equal(await interactions.confirm("t", "Proceed?"), false);
});

test("input returns trimmed text and undefined on blank", async () => {
  const { interactions } = interactionsWithAnswers(["  hello  ", "   "]);
  assert.equal(await interactions.input("Say it", undefined), "hello");
  assert.equal(await interactions.input("Say it", undefined), undefined);
});

test("an aborted Run signal rejects with its exact abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("run cancelled");
  controller.abort(reason);

  const interactions = new CliInteractions({
    question: async (_prompt, options) => {
      options?.signal?.throwIfAborted();
      return "1";
    },
  });

  await assert.rejects(
    interactions.select("Allow?", ["Yes", "No"], { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
});

test("a cancelled question without an aborted Run returns a neutral value", async () => {
  const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
  const interactions = new CliInteractions({
    question: async () => {
      throw abortError;
    },
  });

  assert.equal(await interactions.select("t", ["a"]), undefined);
  assert.equal(await interactions.confirm("t", "m"), false);
  assert.equal(await interactions.input("t"), undefined);
});

test("unexpected question failures propagate", async () => {
  const interactions = new CliInteractions({
    question: async () => {
      throw new Error("broken pipe");
    },
  });

  await assert.rejects(interactions.select("t", ["a"]), /broken pipe/);
});
