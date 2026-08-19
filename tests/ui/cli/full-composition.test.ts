import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Interface } from "node:readline/promises";

import type { ModelConfig } from "../../../src/core/ai/index.js";
import type { AssistantMessage } from "../../../src/core/ai/types.js";
import { openOrCreateProject } from "../../../src/coding-agent/index.js";
import type {
  Interactions,
  PermissionReply,
  PermissionRequest,
} from "../../../src/coding-agent/index.js";
import type { TestStream } from "../../fixtures/model-runtime.js";
import { runtimeFromStream } from "../../fixtures/model-runtime.js";
import { CliUi } from "../../../src/ui/cli/index.js";

const MODEL: ModelConfig = { provider: "test", model: "test-model" };

const toolTurn: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "好的，我来使用 `todo_write` 工具创建一个任务列表" },
    {
      type: "toolCall",
      id: "c1",
      name: "todo_write",
      arguments: { todos: [{ content: "test the UI", status: "pending" }] },
    },
  ],
  model: "test-model",
  stopReason: "toolUse",
  latencyMs: 0,
};

const finalTurn: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "任务列表已创建" }],
  model: "test-model",
  stopReason: "stop",
  latencyMs: 0,
};

/** Mirrors a real model stream: text, then a todo_write call, then the summary turn. */
function toolCallingStream(): { stream: TestStream; streamCalls: () => number } {
  let turns = 0;
  const stream: TestStream = async function* () {
    turns += 1;
    if (turns === 1) {
      yield { type: "text_delta", text: "好的，我来使用 `todo_write` 工具创建一个任务列表" };
      yield { type: "toolcall_start", id: "c1", name: "todo_write" };
      yield {
        type: "toolcall_delta",
        id: "c1",
        argumentsDelta: '{"todos":[{"content":"test the UI","status":"pending"}]}',
      };
      yield {
        type: "toolcall_end",
        toolCall: {
          type: "toolCall",
          id: "c1",
          name: "todo_write",
          arguments: { todos: [{ content: "test the UI", status: "pending" }] },
        },
      };
      yield { type: "done", message: toolTurn };
    } else {
      yield { type: "done", message: finalTurn };
    }
  };
  return { stream, streamCalls: () => turns };
}

/** todo_write is permission-free; a question here means the run is misbehaving. */
const interactions: Interactions = {
  async permission(
    _request: PermissionRequest,
    _signal?: AbortSignal,
  ): Promise<PermissionReply> {
    throw new Error("unexpected permission question for todo_write");
  },
};

test("the full composition renders tool calls and the run summary", async () => {
  const keaHome = await mkdtemp(join(tmpdir(), "kea-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "kea-project-"));
  try {
    const { stream, streamCalls } = toolCallingStream();
    const project = await openOrCreateProject({
      keaHome,
      projectDirectory: projectDir,
      runtime: runtimeFromStream(stream),
      modelConfig: MODEL,
      interactions,
      maxTurns: 5,
      toolTimeoutSeconds: 30,
    });
    const harness = await project.createHarness();

    const queue = ["你能否使用 todo write 工具，我要测试一下 UI 展示", "/exit"];
    const chunks: string[] = [];
    const readline = {
      question: async (prompt: string): Promise<string> => queue.shift() ?? "/exit",
      close: () => {},
    } as unknown as Interface;

    const ui = new CliUi({
      models: [MODEL],
      thinking: "hidden",
      toolDetails: "compact",
      color: false,
      readline,
      write: (text) => chunks.push(text),
      log: () => {},
      reportError: (error) => chunks.push(`ERROR: ${String(error)}`),
    });
    await ui.run(project, harness);
    ui.close();

    const text = chunks.join("");
    // eslint-disable-next-line no-console
    console.log(`RENDERED: ${JSON.stringify(text)}`);

    assert.equal(streamCalls(), 2);
    assert.ok(text.includes('⚙ todo_write {"todos"'), "tool call must stream on one line");
    assert.ok(text.includes("✓ todo_write"), "tool result must render");
    assert.ok(text.includes("✓ completed"), "run summary must render");
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});
