import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Interface } from "node:readline/promises";

import { CliFrontend } from "../../src/ui/frontend.js";
import { CodingToolPresentationRegistry } from "../../src/coding-agent/ui/presentation-registry.js";
import type {
  CodingAgentRuntime,
  ConfirmationRequest,
} from "../../src/coding-agent/index.js";

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

function frontendWithQuestion(
  question: QuestionFn,
  input = new FakeInput(),
  log: (text: string) => void = () => undefined,
): CliFrontend {
  return new CliFrontend({
    readline: fakeReadline(question),
    input: input as unknown as NodeJS.ReadStream,
    write: () => undefined,
    log,
  });
}

function frontendWithAnswer(answer: string): CliFrontend {
  return frontendWithQuestion(async () => answer);
}

function frontendWithLogs(logs: string[]): CliFrontend {
  return frontendWithQuestion(
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
    const cli = frontendWithAnswer(answer);
    assert.equal(await cli.confirm(confirmation), expected);
    cli.close();
  }
});

test("confirm forwards AbortSignal to readline and returns false when aborted", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const cli = frontendWithQuestion(async (_prompt, options) => {
    assert.ok(options?.signal);
    seen.push(options.signal);
    controller.abort();
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });

  assert.equal(await cli.confirm(confirmation, controller.signal), false);
  assert.equal(seen.length, 1);
  cli.close();
});

test("ESC cancels confirmation instead of invoking the run abort listener", async () => {
  const input = new FakeInput();
  const cli = frontendWithQuestion((_prompt, options) =>
    new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
      input.emit("data", Buffer.from([0x1b]));
    }), input);

  assert.equal(await cli.confirm(confirmation), false);
  cli.close();
});

// ── Notification tests ──

test("notify renders the supplied Hook message", () => {
  const logs: string[] = [];
  const cli = frontendWithLogs(logs);
  cli.notify({
    source: "summary",
    level: "info",
    message: "[HOOK] Stop: session used 2 tool calls",
  });
  assert.deepEqual(logs, ["[HOOK] Stop: session used 2 tool calls"]);
  cli.close();
});

// ── Run-listener suspension/restoration ──

test("run suspends its ESC listener during confirm and restores it after", async () => {
  const input = new FakeInput();
  let mainQuestions = 0;
  let aborts = 0;
  const cli = frontendWithQuestion(async (query) => {
    if (query.includes("Allow?")) {
      assert.equal(input.listenerCount("data"), 1);
      return "y";
    }
    mainQuestions++;
    return mainQuestions === 1 ? "run command" : "q";
  }, input);

  const runtime = {
    harness: {
      subscribe() {
        return () => undefined;
      },
      abort() {
        aborts++;
      },
      async prompt() {
        assert.equal(input.listenerCount("data"), 1);
        assert.equal(await cli.confirm(confirmation), true);
        assert.equal(input.listenerCount("data"), 1);
        input.emit("data", Buffer.from([0x1b]));
      },
    },
    presentations: new CodingToolPresentationRegistry(),
  } as unknown as CodingAgentRuntime;

  await cli.run(runtime);
  assert.equal(aborts, 1);
  assert.equal(input.listenerCount("data"), 0);
  cli.close();
});
