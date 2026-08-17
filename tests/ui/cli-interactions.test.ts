import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Interface } from "node:readline/promises";

import { CliInteractions } from "../../src/ui/cli-interactions.js";
import type { PermissionRequest } from "../../src/coding-agent/index.js";

type QuestionFn = (
  query: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    return this;
  }
}

const call = {
  type: "toolCall",
  id: "c1",
  name: "bash",
  arguments: {},
} as const;

const dangerousRequest: PermissionRequest = {
  kind: "dangerous-command",
  sessionId: "session-1",
  runId: "run-1",
  call,
  command: "rm file.txt",
  cwd: "/work/project",
  reason: "file deletion requires approval",
};

const externalRequest: PermissionRequest = {
  kind: "external-directory",
  sessionId: "session-1",
  runId: "run-1",
  call,
  targetPath: "/outside/target",
  directory: "/work/project",
  reason: "outside the project directory",
};

function fakeReadline(question: QuestionFn): Interface {
  return {
    question,
    on() { return this; },
    close() {},
  } as unknown as Interface;
}

function interactionsWithQuestion(
  question: QuestionFn,
  input = new FakeInput(),
  log: (text: string) => void = () => undefined,
): CliInteractions {
  return new CliInteractions({
    readline: fakeReadline(question),
    input: input as unknown as NodeJS.ReadStream,
    log,
  });
}

function interactionsWithAnswer(answer: string): CliInteractions {
  return interactionsWithQuestion(async () => answer);
}

// ── Permission tests ──

test("permission maps answers to replies and defaults to deny", async () => {
  for (const [answer, expected] of [
    ["y", { kind: "once" }],
    ["YES", { kind: "once" }],
    ["a", { kind: "always" }],
    ["always", { kind: "always" }],
    ["", { kind: "deny" }],
    ["n", { kind: "deny" }],
    ["anything", { kind: "deny" }],
  ] as const) {
    const interactions = interactionsWithAnswer(answer);
    assert.deepEqual(await interactions.permission(dangerousRequest), expected);
    interactions.close();
  }
});

test("permission forwards AbortSignal to readline and denies when aborted", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const interactions = interactionsWithQuestion(async (_prompt, options) => {
    assert.ok(options?.signal);
    seen.push(options.signal);
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });

  assert.deepEqual(
    await interactions.permission(dangerousRequest, controller.signal),
    { kind: "deny" },
  );
  assert.equal(seen.length, 1);
  interactions.close();
});

test("ESC cancels permission instead of invoking the run abort listener", async () => {
  const input = new FakeInput();
  const interactions = interactionsWithQuestion((_prompt, options) =>
    new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
      input.emit("data", Buffer.from([0x1b]));
    }), input);

  assert.deepEqual(await interactions.permission(dangerousRequest), { kind: "deny" });
  interactions.close();
});

test("permission prompt shows the command or the external target", async () => {
  const queries: string[] = [];
  const interactions = interactionsWithQuestion(async (query) => {
    queries.push(query);
    return "";
  });

  await interactions.permission(dangerousRequest);
  await interactions.permission(externalRequest);

  assert.match(queries[0] ?? "", /file deletion requires approval/);
  assert.match(queries[0] ?? "", /rm file\.txt/);
  assert.match(queries[1] ?? "", /outside the project directory/);
  assert.match(queries[1] ?? "", /\/outside\/target/);
  interactions.close();
});
