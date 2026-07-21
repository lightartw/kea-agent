import type {
  LLMClient,
  LLMResponse,
  Message,
} from "./llm-client/types.js";
import type { ToolCall, ToolResult } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";

export type AgentEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | {
      readonly type: "tool_end";
      readonly call: ToolCall;
      readonly result: ToolResult;
    }
  | { readonly type: "turn_end"; readonly response: LLMResponse };

export async function* runAgentTurn(
  messages: Message[],
  client: LLMClient,
  registry: ToolRegistry,
): AsyncIterable<AgentEvent> {
  while (true) {
    let response: LLMResponse | undefined;
    for await (const event of client.stream(messages, registry.schemas())) {
      if (event.type === "text_delta") {
        yield event;
      } else {
        response = event.response;
      }
    }

    if (response === undefined) {
      throw new Error("LLM stream ended without response_done");
    }

    const assistantMessage: Message =
      response.toolCalls.length > 0
        ? {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls,
          }
        : { role: "assistant", content: response.content ?? "" };
    messages.push(assistantMessage);

    if (response.toolCalls.length === 0) {
      yield { type: "turn_end", response };
      return;
    }

    for (const call of response.toolCalls) {
      yield { type: "tool_start", call };
      const result = await registry.execute(call);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
      yield { type: "tool_end", call, result };
    }
  }
}
