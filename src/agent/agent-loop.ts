import type {
  LLMClient,
  LLMResponse,
  Message,
} from "../llm-client/types.js";
import type { AgentEvent } from "./types.js";
import type { ToolCall, ToolResult } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * Run one user turn. A turn may contain several provider round trips when the
 * model calls tools; it ends only when the model returns no further tool calls.
 */
export async function* runAgentTurn(
  messages: Message[],
  client: LLMClient,
  registry: ToolRegistry,
): AsyncIterable<AgentEvent> {
  while (true) {
    // Stream text immediately, but wait for response_done before trusting tool
    // arguments because adapters assemble them incrementally.
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

    // Store exactly one complete assistant message for this provider response.
    // Tool calls must be in history before their results are appended.
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

    // Preserve provider order: later calls may depend on earlier side effects.
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
