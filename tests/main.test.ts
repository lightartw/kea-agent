import assert from "node:assert/strict";
import test from "node:test";

import { CliHarnessRenderer } from "../src/ui/cli-harness-renderer.js";
import { AgentHarness } from "../src/harness/agent-harness.js";
import { Session } from "../src/harness/session/session.js";
import { AgentToolRegistry } from "../src/agent/tools/registry.js";
import { Events } from "../src/events/events.js";
import type { AssistantMessage, StreamFn } from "../src/ai/types.js";

const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

test("Harness renders through one subscription while prompt returns a Promise", async () => {
  const rendered: string[] = [];
  const logs: string[] = [];
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "hello" };
    yield { type: "done", message };
  };
  const events = new Events();
  const harness = new AgentHarness({
    session: Session.inMemory({
      projectId: "project_test",
      directory: process.cwd(),
      cwd: ".",
    }),
    model: { provider: "test", model: "test" },
    streamFn: stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: () => "",
    cwd: process.cwd(),
    events,
  });
  const renderer = new CliHarnessRenderer(
    { write: (text) => rendered.push(text), log: (text) => logs.push(text) },
    (event) => `[${event.type}] ${event.call.name}`,
  );
  const unsubscribe = renderer.bind(events, harness.sessionId);

  const run: Promise<void> = harness.prompt("hello");
  await run;
  unsubscribe();

  assert.deepEqual(rendered, ["hello"]);
  assert.deepEqual(logs, ["session used 0 tool calls"]);
});
