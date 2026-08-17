import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Interface } from "node:readline/promises";

import { CliFrontend } from "../../src/ui/cli-frontend.js";
import type {
  PermissionRequest,
  Project,
} from "../../src/coding-agent/index.js";
import type { AgentHarness } from "../../src/core/harness/index.js";
import { Events } from "../../src/core/events/events.js";

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

const permissionRequest: PermissionRequest = {
  kind: "dangerous-command",
  sessionId: "session-1",
  runId: "run-1",
  call: { type: "toolCall", id: "c1", name: "bash", arguments: {} },
  command: "rm file.txt",
  cwd: "/work/project",
  reason: "file deletion requires approval",
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

test("run suspends its ESC listener during permission and restores it after", async () => {
  const input = new FakeInput();
  let mainQuestions = 0;
  let aborts = 0;
  const cli = frontendWithQuestion(async (query) => {
    if (query.includes("Allow once")) {
      assert.equal(input.listenerCount("data"), 1);
      return "y";
    }
    mainQuestions++;
    return mainQuestions === 1 ? "run command" : "q";
  }, input);

  const harness = {
    sessionId: "session-1",
    abort() {
      aborts++;
    },
    async prompt() {
      assert.equal(input.listenerCount("data"), 1);
      assert.deepEqual(await cli.interactions.permission(permissionRequest), { kind: "once" });
      assert.equal(input.listenerCount("data"), 1);
      assert.equal(input.rawModes.at(-1), true);
      input.emit("data", Buffer.from([0x1b]));
    },
  } as unknown as AgentHarness;
  const project = {
    events: new Events(),
  } as unknown as Project;

  await cli.run(project, harness);
  assert.equal(aborts, 1);
  assert.equal(input.listenerCount("data"), 0);
  cli.close();
});
