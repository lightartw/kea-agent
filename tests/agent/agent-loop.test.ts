import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { runAgentTurn } from "../../src/agent/agent-loop.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ContentBlock,
  Context,
  LLMClient,
  Message,
} from "../../src/llm-client/types.js";
import { AgentTool } from "../../src/agent/tools/types.js";
import { ToolRegistry } from "../../src/agent/tools/registry.js";

const emptyParameters = Type.Object({}, { additionalProperties: false });

function assistantMsg(
  text: string,
  extraContent: ContentBlock[] = [],
): AssistantMessage {
  const content: ContentBlock[] = [];
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  content.push(...extraContent);
  const hasToolCalls = extraContent.some((block) => block.type === "toolCall");
  return {
    role: "assistant",
    content,
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    stopReason: hasToolCalls ? "toolUse" : "stop",
    latencyMs: 0,
  };
}

function clientWithStreams(
  streams: readonly (readonly AssistantMessageEvent[])[],
  beforeStream?: (context: Context, index: number) => void,
): LLMClient {
  let index = 0;
  return {
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
  const final = assistantMsg("hello");
  const history: Message[] = [{ role: "user", content: "hi" }];
  const client = clientWithStreams([[
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "done", message: final },
  ]]);

  const events = await collect(
    runAgentTurn(history, "", client, new ToolRegistry()),
  );

  assert.deepEqual(events, [
    { type: "text_delta", text: "hel" },
    { type: "text_delta", text: "lo" },
    { type: "turn_end", message: final },
  ]);
  assert.deepEqual(history.at(-1), final);
});

test("runAgentTurn streams and executes tools sequentially", async () => {
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
  const tc1 = { type: "toolCall" as const, id: "c1", name: "first", arguments: {} };
  const tc2 = { type: "toolCall" as const, id: "c2", name: "second", arguments: {} };
  const finalMsg = assistantMsg("finished");
  const client: LLMClient = {
    async *stream(_context, _options) {
      if (observed.length === 0) {
        observed.push("done");
        yield { type: "toolcall_start", id: "c1", name: "first" };
        yield { type: "toolcall_end", toolCall: tc1 };
        yield { type: "toolcall_start", id: "c2", name: "second" };
        yield { type: "toolcall_end", toolCall: tc2 };
        yield { type: "done", message: assistantMsg("", [tc1, tc2]) };
      } else {
        yield { type: "text_delta", text: "finished" };
        yield { type: "done", message: finalMsg };
      }
    },
  };
  const history: Message[] = [{ role: "user", content: "run" }];

  const events = await collect(runAgentTurn(history, "", client, registry));

  assert.deepEqual(observed, ["done", "first", "second"]);
  assert.deepEqual(events.map((event) => event.type), [
    "toolcall_start",
    "toolcall_end",
    "toolcall_start",
    "toolcall_end",
    "tool_start",
    "tool_end",
    "tool_start",
    "tool_end",
    "text_delta",
    "turn_end",
  ]);
  assert.deepEqual(
    events.at(-1),
    { type: "turn_end", message: finalMsg },
  );
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
  const tc = { type: "toolCall" as const, id: "c1", name: "noop", arguments: {} };
  let secondHistory: readonly Message[] | undefined;
  const client = clientWithStreams(
    [
      [
        { type: "toolcall_start", id: "c1", name: "noop" },
        { type: "toolcall_end", toolCall: tc },
        { type: "done", message: assistantMsg("", [tc]) },
      ],
      [{ type: "done", message: assistantMsg("") }],
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
  assert.deepEqual(history.at(-1), assistantMsg(""));
});

test("Registry failures are emitted and returned to the model", async () => {
  const missingCall = { type: "toolCall" as const, id: "c1", name: "missing", arguments: {} };
  const client = clientWithStreams([
    [
      { type: "toolcall_start", id: "c1", name: "missing" },
      { type: "toolcall_end", toolCall: missingCall },
      { type: "done", message: assistantMsg("", [missingCall]) },
    ],
    [{ type: "done", message: assistantMsg("recovered") }],
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
