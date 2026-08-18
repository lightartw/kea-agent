import assert from "node:assert/strict";
import test from "node:test";

import type { Interface } from "node:readline/promises";

import type { AgentMessage } from "../../../src/core/agent/index.js";
import type { ModelConfig } from "../../../src/core/ai/index.js";
import type { AgentHarness, SessionMetadata } from "../../../src/core/harness/index.js";
import type { HarnessEvent } from "../../../src/core/harness/index.js";
import type { Project, PermissionRequest } from "../../../src/coding-agent/index.js";

import { CliUi } from "../../../src/ui/cli/cli-ui.js";

const MODEL: ModelConfig = { provider: "openai", model: "gpt-5" };

const PERMISSION_REQUEST: PermissionRequest = {
  kind: "dangerous-command",
  sessionId: "session-1",
  runId: "run-1",
  call: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rm -rf /tmp/x" } },
  command: "rm -rf /tmp/x",
  cwd: "/repo",
  reason: "needs approval",
};

function asHarness(harness: FakeHarnessState): AgentHarness {
  return harness as unknown as AgentHarness;
}

/** Test-only fake Harness; cast to the public type, no production interface. */
interface FakeHarnessState {
  readonly sessionId: string;
  model: ModelConfig;
  readonly messages: readonly AgentMessage[];
  isRunning: boolean;
  prompt: (input: string) => Promise<void>;
  switchModel: (model: ModelConfig) => Promise<void>;
  abort: () => void;
  subscribe: (listener: (event: HarnessEvent) => void) => () => void;
  readonly promptCalls: string[];
  readonly switchModelCalls: ModelConfig[];
  abortCalls: number;
  subscribeCalls: number;
  unsubscribeCalls: number;
}

function makeHarness(
  id: string,
  options: {
    readonly model?: ModelConfig;
    readonly messages?: readonly AgentMessage[];
    readonly isRunning?: boolean;
  } = {},
): FakeHarnessState {
  const harness: FakeHarnessState = {
    sessionId: `session-${id}`,
    model: options.model ?? MODEL,
    messages: options.messages ?? [],
    isRunning: options.isRunning ?? false,
    prompt: async () => {},
    switchModel: async () => {},
    abort: () => {},
    subscribe: () => () => {},
    promptCalls: [],
    switchModelCalls: [],
    abortCalls: 0,
    subscribeCalls: 0,
    unsubscribeCalls: 0,
  };
  harness.prompt = async (input) => { harness.promptCalls.push(input); };
  harness.switchModel = async (model) => {
    harness.model = model;
    harness.switchModelCalls.push(model);
  };
  harness.abort = () => { harness.abortCalls += 1; };
  harness.subscribe = () => {
    harness.subscribeCalls += 1;
    return () => { harness.unsubscribeCalls += 1; };
  };
  return harness;
}

function makeProject(options: {
  readonly listSessions?: () => Promise<readonly SessionMetadata[]>;
  readonly createHarness?: () => Promise<AgentHarness>;
  readonly createHarnessFromSession?: (sessionId: string) => Promise<AgentHarness>;
} = {}): Project {
  return {
    listSessions: options.listSessions ?? (async () => []),
    createHarness: options.createHarness ?? (async () => {
      throw new Error("no harness");
    }),
    createHarnessFromSession: options.createHarnessFromSession ?? (async () => {
      throw new Error("no session");
    }),
  } as unknown as Project;
}

function makeReadline(
  answers: readonly string[],
): { readonly readline: Interface; readonly calls: string[] } {
  const queue = [...answers];
  const calls: string[] = [];
  const readline = {
    question: async (prompt: string): Promise<string> => {
      calls.push(prompt.startsWith("\n⚠") ? "question:permission" : `question:${prompt}`);
      return queue.shift() ?? "/exit";
    },
    close: () => {},
  } as unknown as Interface;
  return { readline, calls };
}

function makeUi(options: {
  readonly models?: readonly ModelConfig[];
  readonly readline: Interface;
  readonly calls: string[];
  readonly write?: (text: string) => void;
}): CliUi {
  return new CliUi({
    models: options.models ?? [MODEL],
    thinking: "hidden",
    toolDetails: "compact",
    readline: options.readline,
    write: options.write ?? ((text) => options.calls.push(`render:${text}`)),
    log: () => {},
    reportError: (error) => options.calls.push(`error:${String(error)}`),
  });
}

function session(id: string, title: string, updatedAt: string): SessionMetadata {
  return {
    id,
    title,
    cwd: "/repo",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
  };
}

test("the outer loop waits for a Run before reading the next Prompt", async () => {
  const { readline, calls } = makeReadline(["hello", "o", "/exit"]);
  const ui = makeUi({
    readline,
    calls,
    write: (text) => {
      if (text.startsWith("\n> ")) calls.push(`render-user:${text.slice(3)}`);
    },
  });

  const harness = makeHarness("1");
  harness.prompt = async () => {
    calls.push("prompt:start");
    await ui.interactions.permission(PERMISSION_REQUEST);
    calls.push("prompt:end");
  };
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.deepEqual(calls, [
    "question:kea> ",
    "render-user:hello",
    "prompt:start",
    "question:permission",
    "prompt:end",
    "question:kea> ",
  ]);
});

test("/new creates a Harness and activates it", async () => {
  const { readline, calls } = makeReadline(["/new", "/exit"]);
  const ui = makeUi({ readline, calls });

  const initial = makeHarness("1");
  const created = makeHarness("2");
  const project = makeProject({ createHarness: async () => asHarness(created) });

  await ui.run(project, initial as unknown as AgentHarness);

  assert.equal(initial.subscribeCalls, 1);
  assert.equal(initial.unsubscribeCalls, 1);
  assert.equal(created.subscribeCalls, 1);
  assert.equal(created.unsubscribeCalls, 0);
  ui.close();
});

test("/session lists newest-first and restores the numbered choice", async () => {
  const { readline, calls } = makeReadline(["/session", "2", "/exit"]);
  const ui = makeUi({ readline, calls });

  const initial = makeHarness("1");
  let restoredFrom: string | undefined;
  const restored = makeHarness("restored", {
    messages: [{ role: "user", content: "earlier question" }],
  });
  const project = makeProject({
    listSessions: async () => [
      session("newest-id", "newest", "2026-08-18T12:00:00.000Z"),
      session("older-id", "older", "2026-08-17T12:00:00.000Z"),
    ],
    createHarnessFromSession: async (sessionId) => {
      restoredFrom = sessionId;
      return asHarness(restored);
    },
  });

  await ui.run(project, initial as unknown as AgentHarness);

  assert.equal(restoredFrom, "older-id");
  assert.equal(initial.unsubscribeCalls, 1);
  assert.equal(restored.subscribeCalls, 1);
  assert.equal(restored.unsubscribeCalls, 0);
  const text = calls.filter((call) => call.startsWith("render:")).join("");
  assert.ok(text.includes("Sessions (newest first):"), text);
  assert.ok(text.indexOf("1. newest") < text.indexOf("2. older"), text);
  assert.ok(text.includes("Session session-restored"), text);
  assert.ok(text.includes("earlier question"), text);
  ui.close();
});

test("a failed Session activation keeps the old Harness active", async () => {
  const { readline, calls } = makeReadline(["/session", "1", "/exit"]);
  const ui = makeUi({ readline, calls });

  const initial = makeHarness("1");
  const project = makeProject({
    listSessions: async () => [session("id-1", "only", "2026-08-18T12:00:00.000Z")],
    createHarnessFromSession: async () => {
      throw new Error("storage failure");
    },
  });

  await ui.run(project, initial as unknown as AgentHarness);

  assert.ok(calls.includes("error:Error: storage failure"), calls.join(" | "));
  assert.equal(initial.subscribeCalls, 1);
  assert.equal(initial.unsubscribeCalls, 0);
  ui.close();
});

test("/model selects only configured models and same model is a no-op", async () => {
  const models: readonly ModelConfig[] = [
    { provider: "openai", model: "gpt-5" },
    { provider: "anthropic", model: "claude-4" },
  ];
  const { readline, calls } = makeReadline(["/model", "1", "/model", "2", "/exit"]);
  const ui = makeUi({ models, readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.deepEqual(harness.switchModelCalls, [{ provider: "anthropic", model: "claude-4" }]);
  assert.equal(harness.model.provider, "anthropic");
});

test("a restored unavailable model asks for a configured model before activation", async () => {
  const models: readonly ModelConfig[] = [{ provider: "anthropic", model: "claude-4" }];
  const { readline, calls } = makeReadline(["1", "/exit"]);
  const ui = makeUi({ models, readline, calls });

  const restored = makeHarness("restored", {
    model: { provider: "openai", model: "gone" },
  });
  const project = makeProject({ createHarness: async () => asHarness(restored) });

  await ui.run(project, asHarness(restored));
  ui.close();

  assert.deepEqual(restored.switchModelCalls, [{ provider: "anthropic", model: "claude-4" }]);
  assert.equal(restored.subscribeCalls, 1);
  const text = calls.filter((call) => call.startsWith("render:")).join("");
  assert.ok(text.includes("model openai/gone is not configured"), text);
});

test("cancelling the initial model repair exits without the prompt loop", async () => {
  const models: readonly ModelConfig[] = [{ provider: "anthropic", model: "claude-4" }];
  const { readline, calls } = makeReadline([""]);
  const ui = makeUi({ models, readline, calls });

  const restored = makeHarness("restored", {
    model: { provider: "openai", model: "gone" },
  });
  const project = makeProject({ createHarness: async () => asHarness(restored) });

  await ui.run(project, asHarness(restored));
  ui.close();

  assert.equal(restored.switchModelCalls.length, 0);
  assert.equal(restored.subscribeCalls, 0);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("question:")),
    ["question:Model number? "],
  );
  ui.close();
});

test("EOF at the prompt exits the loop", async () => {
  const calls: string[] = [];
  const readline = {
    question: async (prompt: string): Promise<string> => {
      calls.push(`question:${prompt}`);
      throw Object.assign(new Error("EOF"), { name: "AbortError" });
    },
    close: () => {},
  } as unknown as Interface;
  const ui = makeUi({ readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));

  assert.deepEqual(
    calls.filter((call) => call.startsWith("question:")),
    ["question:kea> "],
  );
  ui.close();
});

test("command errors render and the loop continues", async () => {
  const { readline, calls } = makeReadline(["/new extra", "/exit"]);
  const ui = makeUi({ readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.ok(
    calls.some((call) => call === "render:\n✗ /new does not accept arguments"),
    calls.join(" | "),
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("question:")),
    ["question:kea> ", "question:kea> "],
  );
});

test("Prompt failures report and the loop continues", async () => {
  const { readline, calls } = makeReadline(["hello", "/exit"]);
  const ui = makeUi({ readline, calls });

  const harness = makeHarness("1");
  harness.prompt = async () => {
    throw new Error("model unavailable");
  };
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.ok(calls.includes("error:Error: model unavailable"), calls.join(" | "));
  assert.deepEqual(
    calls.filter((call) => call.startsWith("question:")),
    ["question:kea> ", "question:kea> "],
  );
});

test("SIGINT during a Run calls abort on the current Harness", async () => {
  const { readline, calls } = makeReadline(["hello", "/exit"]);
  const ui = makeUi({ readline, calls });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = makeHarness("1");
  harness.isRunning = true;
  harness.prompt = async () => {
    calls.push("prompt:started");
    await gate;
  };
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  const runPromise = ui.run(project, asHarness(harness));
  for (let attempt = 0; attempt < 100 && !calls.includes("prompt:started"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(calls.includes("prompt:started"), "prompt never started");
  process.emit("SIGINT");
  assert.equal(harness.abortCalls, 1);
  release();
  await runPromise;
  assert.equal(harness.abortCalls, 1);
  ui.close();
});

test("close is idempotent and closes readline once", async () => {
  let closeCalls = 0;
  const calls: string[] = [];
  const readline = {
    question: async (prompt: string): Promise<string> => {
      calls.push(`question:${prompt}`);
      return "/exit";
    },
    close: () => { closeCalls += 1; },
  } as unknown as Interface;
  const ui = makeUi({ readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();
  ui.close();

  assert.equal(closeCalls, 1);
  assert.equal(harness.unsubscribeCalls, 1);
});
