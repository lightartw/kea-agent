import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";

import { AgentHarness } from "../../../src/core/harness/agent-harness.js";
import { Session } from "../../../src/core/harness/session/session.js";
import { AgentToolRegistry } from "../../../src/core/harness/tools/registry.js";
import type { AgentToolCall } from "../../../src/core/harness/tools/types.js";
import type { AssistantMessage, ModelConfig } from "../../../src/core/ai/types.js";
import { runtimeFromStream } from "../../fixtures/model-runtime.js";
import { registerBuiltinHooks } from "../../../src/coding-agent/hooks/register.js";
import type { PermissionRule } from "../../../src/coding-agent/hooks/permission/permission.js";
import type { UserInteraction } from "../../../src/coding-agent/interaction/interactions.js";

const PROJECT = resolve(join("work", "project"));

const modelConfig: ModelConfig = { provider: "test", model: "model-a" };
const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

const testInteraction: UserInteraction = {
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

function makeHarness(
  interaction: UserInteraction,
  approved: PermissionRule[] = [],
): AgentHarness {
  const harness = new AgentHarness({
    session: Session.inMemory({ cwd: process.cwd() }),
    runtime: runtimeFromStream(async function* () {
      yield { type: "done", message: assistant };
    }),
    modelConfig,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: "system",
  });
  registerBuiltinHooks(harness, {
    approved,
    interaction,
    trustedDirectories: [PROJECT],
  });
  return harness;
}

function bashCall(command: string): AgentToolCall {
  return { type: "toolCall", id: "c1", name: "bash", arguments: { command } };
}

const hookCtx = { sessionId: "s", runId: "r", cwd: PROJECT };

test("registerBuiltinHooks wires Permission as a beforeTool hook", async () => {
  const harness = makeHarness(testInteraction);

  assert.deepEqual(
    await harness.hooks.beforeTool(bashCall("echo hello"), hookCtx),
    { kind: "allow" },
  );
  assert.deepEqual(
    await harness.hooks.beforeTool(bashCall("sudo true"), hookCtx),
    { kind: "deny", reason: "sudo is not allowed" },
  );
});
