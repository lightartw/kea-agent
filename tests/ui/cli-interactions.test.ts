import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Interface } from "node:readline/promises";

import { CliInteractions } from "../../src/ui/cli-interactions.js";
import type { ConfirmationRequest } from "../../src/coding-agent/index.js";

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

const confirmation: ConfirmationRequest = {
  source: "permission",
  title: "Allow Bash command?",
  message: "file deletion requires approval\nTool: bash({\"command\":\"rm file.txt\"})",
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

function interactionsWithLogs(logs: string[]): CliInteractions {
  return interactionsWithQuestion(
    async () => "",
    new FakeInput(),
    (text) => logs.push(text),
  );
}

// ── Confirmation tests ──

test("confirm accepts only y or yes and defaults to deny", async () => {
  for (const [answer, expected] of [
    ["y", true],
    ["YES", true],
    ["", false],
    ["n", false],
    ["anything", false],
  ] as const) {
    const interactions = interactionsWithAnswer(answer);
    assert.equal(await interactions.confirm(confirmation), expected);
    interactions.close();
  }
});

test("confirm forwards AbortSignal to readline and returns false when aborted", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const interactions = interactionsWithQuestion(async (_prompt, options) => {
    assert.ok(options?.signal);
    seen.push(options.signal);
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });

  assert.equal(await interactions.confirm(confirmation, controller.signal), false);
  assert.equal(seen.length, 1);
  interactions.close();
});

test("ESC cancels confirmation instead of invoking the run abort listener", async () => {
  const input = new FakeInput();
  const interactions = interactionsWithQuestion((_prompt, options) =>
    new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
      input.emit("data", Buffer.from([0x1b]));
    }), input);

  assert.equal(await interactions.confirm(confirmation), false);
  interactions.close();
});

// ── Notification tests ──

test("notify renders the supplied message", () => {
  const logs: string[] = [];
  const interactions = interactionsWithLogs(logs);
  interactions.notify({
    source: "summary",
    level: "info",
    message: "[HOOK] Stop: session used 2 tool calls",
  });
  assert.deepEqual(logs, ["[HOOK] Stop: session used 2 tool calls"]);
  interactions.close();
});
