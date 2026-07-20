import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { agentLoop } from "../src/agent-loop.js";
import type {
  LLMCallOptions,
  LLMClient,
} from "../src/llm-client/client.js";
import { validateMessages } from "../src/llm-client/client.js";
import { LLMProviderError } from "../src/llm-client/errors.js";
import type {
  LLMResponse,
  Message,
} from "../src/llm-client/models.js";
import { Tool } from "../src/tools/base.js";
import type { ToolResult } from "../src/tools/base.js";
import { ToolRegistry } from "../src/tools/registry.js";

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

async function withoutConsole<T>(operation: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = original;
  }
}

test("agentLoop executes calls in order and appends common history", async () => {
  const executionOrder: string[] = [];
  class OrderedTool extends Tool<typeof emptyParameters> {
    constructor(name: string) {
      super(name, `Run ${name}.`, emptyParameters);
    }
    async execute(): Promise<string> {
      executionOrder.push(this.name);
      return `${this.name} result`;
    }
  }
  const registry = new ToolRegistry();
  registry.register(new OrderedTool("first"));
  registry.register(new OrderedTool("second"));

  let invocation = 0;
  const client: LLMClient = {
    async invoke() {
      throw new Error("plain invoke is not used by the Agent loop");
    },
    async invokeWithTools() {
      invocation += 1;
      return invocation === 1
        ? response(null, [
            { id: "call-1", name: "first", arguments: {} },
            { id: "call-2", name: "second", arguments: {} },
          ])
        : response("finished");
    },
    async *streamInvoke() {
      yield "unused";
    },
  };
  const history: Message[] = [
    { role: "system", content: "system" },
    { role: "user", content: "run tools" },
  ];

  const final = await withoutConsole(() => agentLoop(history, client, registry));

  assert.equal(final.content, "finished");
  assert.deepEqual(executionOrder, ["first", "second"]);
  assert.deepEqual(
    history.map((message) => message.role),
    ["system", "user", "assistant", "tool", "tool", "assistant"],
  );
  assert.deepEqual(history[3], {
    role: "tool",
    toolCallId: "call-1",
    name: "first",
    content: "first result",
  });
});

test("agentLoop appends Registry errors as normal tool results", async () => {
  const registry = new ToolRegistry();
  let invocation = 0;
  const client: LLMClient = {
    async invoke() {
      return response("unused");
    },
    async invokeWithTools() {
      invocation += 1;
      return invocation === 1
        ? response(null, [
            { id: "missing-id", name: "missing", arguments: {} },
          ])
        : response("finished");
    },
    async *streamInvoke() {
      yield "unused";
    },
  };
  const history: Message[] = [{ role: "user", content: "run" }];

  await withoutConsole(() => agentLoop(history, client, registry));

  assert.deepEqual(history[2], {
    role: "tool",
    toolCallId: "missing-id",
    name: "missing",
    content: "Error: Unknown tool 'missing'",
  });
});

test("agentLoop passes the caller signal to the client and Registry", async () => {
  class NoopTool extends Tool<typeof emptyParameters> {
    constructor() {
      super("noop", "Run noop.", emptyParameters);
    }
    async execute(): Promise<string> {
      return "ok";
    }
  }
  let registrySignal: AbortSignal | undefined;
  class CapturingRegistry extends ToolRegistry {
    override execute(
      name: string,
      arguments_: unknown,
      signal?: AbortSignal,
    ): Promise<ToolResult> {
      registrySignal = signal;
      return super.execute(name, arguments_, signal);
    }
  }
  const registry = new CapturingRegistry();
  registry.register(new NoopTool());
  const controller = new AbortController();
  let clientSignal: AbortSignal | undefined;
  let invocation = 0;
  const client: LLMClient = {
    async invoke() {
      return response("unused");
    },
    async invokeWithTools(
      _messages,
      _tools,
      options?: LLMCallOptions,
    ) {
      clientSignal = options?.signal;
      invocation += 1;
      return invocation === 1
        ? response(null, [{ id: "c1", name: "noop", arguments: {} }])
        : response("done");
    },
    async *streamInvoke() {
      yield "unused";
    },
  };

  await withoutConsole(() =>
    agentLoop(
      [{ role: "user", content: "run" }],
      client,
      registry,
      controller.signal,
    ),
  );

  assert.equal(clientSignal, controller.signal);
  assert.equal(registrySignal, controller.signal);
});

test("agentLoop rejects non-object provider tool arguments defensively", async () => {
  const client: LLMClient = {
    async invoke() {
      return response("unused");
    },
    async invokeWithTools() {
      return response(null, [
        { id: "c1", name: "bad", arguments: [] as never },
      ]);
    },
    async *streamInvoke() {
      yield "unused";
    },
  };
  const history: Message[] = [{ role: "user", content: "run" }];

  await assert.rejects(
    agentLoop(history, client, new ToolRegistry()),
    LLMProviderError,
  );
  assert.equal(history.length, 1);
});

test("agentLoop keeps an empty final response valid for the next turn", async () => {
  const client: LLMClient = {
    async invoke() {
      return response(null);
    },
    async invokeWithTools() {
      return response(null);
    },
    async *streamInvoke() {
      yield "unused";
    },
  };
  const history: Message[] = [{ role: "user", content: "first" }];

  await agentLoop(history, client, new ToolRegistry());
  history.push({ role: "user", content: "second" });

  assert.deepEqual(history[1], { role: "assistant", content: "" });
  assert.doesNotThrow(() => validateMessages(history));
});
