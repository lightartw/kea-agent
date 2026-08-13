import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Interface } from "node:readline/promises";

import { CliFrontend } from "../../src/ui/cli-frontend.js";
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
        assert.equal(await cli.interactions.confirm(confirmation), true);
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
