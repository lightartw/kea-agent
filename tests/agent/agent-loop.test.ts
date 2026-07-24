import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { runAgentTurn } from "../../src/agent/agent-loop.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type {
  Context,
  LLMClient,
  LLMResponse,
  LLMStreamEvent,
  Message,
} from "../../src/llm-client/types.js";
import { AgentTool } from "../../src/agent/tools/types.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";

const emptyParameters = Type.Object({}, { additionalProperties: false });

function response(
  content: string | null,
  toolCalls: LLMResponse["toolCalls"] = [],
): LLMResponse {
  return {
    model: "test-model",
    content,
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 0,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function clientWithStreams(
  streams: readonly (readonly LLMStreamEvent[])[],
  beforeStream?: (context: Context, index: number) => void,
): LLMClient {
  let index = 0;
  return {
    async invoke() {
      return response("unused");
    },
    async *stream(context) {
      const current = index;
      index += 1;
      beforeStream?.(context, current);
      for (const event of streams[current] ?? []) yield event;
    },
  };
}

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("runAgentTurn streams text and stores one complete assistant message", async () => {
  const final = response("hello");
  const history: Message[] = [{ role: "user", content: "hi" }];
  const client = clientWithStreams([[
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "response_done", response: final },
  ]]);

  const events = await collect(
    runAgentTurn(history, "", client, new ToolRegistry()),
  );

  assert.deepEqual(events, [
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "turn_end", response: final },
  ]);
  assert.deepEqual(history.at(-1), { role: "assistant", content: "hello" });
});

test("runAgentTurn waits for response_done and executes tools sequentially", async () => {
  const observed: string[] = [];
  class OrderedTool extends AgentTool<typeof emptyParameters> {
    constructor(name: string) {
      super(name, `Run ${name}.`, emptyParameters);
    }
    async execute(): Promise<string> {
      observed.push(this.name);
      return `${this.name} result`;
    }
  }
  const registry = new ToolRegistry();
  registry.register(new OrderedTool("first"));
  registry.register(new OrderedTool("second"));
  const firstResponse = response(null, [
    { type: "toolCall" as const, id: "c1", name: "first", arguments: {} },
    { type: "toolCall" as const, id: "c2", name: "second", arguments: {} },
  ]);
  const finalResponse = response("finished");
  const client: LLMClient = {
    async invoke() {
      return response("unused");
    },
    async *stream(_context, _options) {
      if (observed.length === 0) {
        observed.push("response_done");
        yield { type: "response_done", response: firstResponse };
      } else {
        yield { type: "text_delta", text: "finished" };
        yield { type: "response_done", response: finalResponse };
      }
    },
  };
  const history: Message[] = [{ role: "user", content: "run" }];

  const events = await collect(runAgentTurn(history, "", client, registry));

  assert.deepEqual(observed, ["response_done", "first", "second"]);
  assert.deepEqual(events.map((event) => event.type), [
    "tool_start",
    "tool_end",
    "tool_start",
    "tool_end",
    "text_delta",
    "turn_end",
  ]);
  assert.deepEqual(
    history.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant"],
  );
});

test("tool results are in history before the next model stream", async () => {
  class NoopTool extends AgentTool<typeof emptyParameters> {
    constructor() {
      super("noop", "Run noop.", emptyParameters);
    }
    async execute(): Promise<string> {
      return "ok";
    }
  }
  const registry = new ToolRegistry();
  registry.register(new NoopTool());
  let secondHistory: readonly Message[] | undefined;
  const client = clientWithStreams(
    [
      [{
        type: "response_done",
        response: response(null, [
          { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} },
        ]),
      }],
      [{ type: "response_done", response: response(null) }],
    ],
    (context, index) => {
      if (index === 1) secondHistory = [...context.messages];
    },
  );
  const history: Message[] = [{ role: "user", content: "run" }];

  await collect(runAgentTurn(history, "", client, registry));

  assert.deepEqual(secondHistory?.at(-1), {
    role: "tool",
    toolCallId: "c1",
    name: "noop",
    content: "ok",
  });
  assert.deepEqual(history.at(-1), { role: "assistant", content: "" });
});

test("Registry failures are emitted and returned to the model", async () => {
  const missingCall = { type: "toolCall" as const, id: "c1", name: "missing", arguments: {} };
  const client = clientWithStreams([
    [{ type: "response_done", response: response(null, [missingCall]) }],
    [{ type: "response_done", response: response("recovered") }],
  ]);
  const history: Message[] = [{ role: "user", content: "run" }];

  const events = await collect(
    runAgentTurn(history, "", client, new ToolRegistry()),
  );

  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.equal(toolEnd?.type, "tool_end");
  if (toolEnd?.type !== "tool_end") return;
  assert.equal(toolEnd.result.isError, true);
  assert.equal(toolEnd.result.content, "Error: Unknown tool 'missing'");
  assert.equal(history[2]?.content, "Error: Unknown tool 'missing'");
});
