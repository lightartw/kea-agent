import assert from "node:assert/strict";
import test from "node:test";

import type { PermissionRequest } from "../../../src/coding-agent/index.js";

import { CliInteractions } from "../../../src/ui/cli/cli-interactions.js";

function dangerousRequest(): PermissionRequest {
  return {
    kind: "dangerous-command",
    sessionId: "session-1",
    runId: "run-1",
    call: {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "rm -rf /tmp/x" },
    },
    command: "rm -rf /tmp/x",
    cwd: "/repo",
    reason: "needs approval",
  };
}

function externalRequest(): PermissionRequest {
  return {
    kind: "external-directory",
    sessionId: "session-1",
    runId: "run-1",
    call: {
      type: "toolCall",
      id: "call-2",
      name: "read_file",
      arguments: { path: "/outside/x" },
    },
    targetPath: "/outside/x",
    directory: "/outside",
    reason: "outside the project directory",
  };
}

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

test("permission maps once, always, and default deny answers", async () => {
  const { interactions, prompts } = interactionsWithAnswers([
    "o",
    "once",
    "a",
    "always",
    "",
    "deny",
    "garbage",
  ]);
  const request = dangerousRequest();

  assert.deepEqual(await interactions.permission(request), { kind: "once" });
  assert.deepEqual(await interactions.permission(request), { kind: "once" });
  assert.deepEqual(await interactions.permission(request), { kind: "always" });
  assert.deepEqual(await interactions.permission(request), { kind: "always" });
  assert.deepEqual(await interactions.permission(request), { kind: "deny" });
  assert.deepEqual(await interactions.permission(request), { kind: "deny" });
  assert.deepEqual(await interactions.permission(request), { kind: "deny" });

  assert.equal(prompts.length, 7);
  for (const prompt of prompts) {
    assert.ok(prompt.includes("rm -rf /tmp/x"), prompt);
    assert.ok(prompt.includes("needs approval"), prompt);
  }
});

test("external-directory prompts show the target path and reason", async () => {
  const { interactions, prompts } = interactionsWithAnswers(["a"]);

  assert.deepEqual(await interactions.permission(externalRequest()), {
    kind: "always",
  });
  assert.ok(prompts[0]!.includes("/outside/x"), prompts[0]);
  assert.ok(prompts[0]!.includes("outside the project directory"), prompts[0]);
});

test("an aborted Run signal rejects with its exact abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("run cancelled");
  controller.abort(reason);

  const interactions = new CliInteractions({
    question: async (_prompt, options) => {
      options?.signal?.throwIfAborted();
      return "o";
    },
  });

  await assert.rejects(
    interactions.permission(dangerousRequest(), controller.signal),
    (error: unknown) => error === reason,
  );
});

test("a cancelled question without an aborted Run returns deny", async () => {
  const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
  const interactions = new CliInteractions({
    question: async () => {
      throw abortError;
    },
  });

  assert.deepEqual(await interactions.permission(dangerousRequest()), {
    kind: "deny",
  });
});

test("unexpected question failures propagate", async () => {
  const interactions = new CliInteractions({
    question: async () => {
      throw new Error("broken pipe");
    },
  });

  await assert.rejects(
    interactions.permission(dangerousRequest()),
    /broken pipe/,
  );
});
