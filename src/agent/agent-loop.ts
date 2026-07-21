import type {
  LLMClient,
  LLMResponse,
  Message,
} from "../llm-client/types.js";
import type { HookRegistry } from "./hooks/registry.js";
import type { AgentEvent } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * Pure function: run one LLM turn over the given message array.
 * Mutates `messages` in place so Agent owns the history while the loop
 * only appends assistant + tool messages.
 */
export async function* runAgentTurn(
  messages: Message[],
  client: LLMClient,
  registry: ToolRegistry,
  hooks?: HookRegistry,
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
      // ④ Stop — before turn_end
      if (hooks !== undefined) {
        const result = await hooks.trigger({
          type: "stop",
          messages: [...messages],
        });
        if (result?.messages !== undefined) {
          messages.length = 0;
          messages.push(...result.messages);
        }
        if (result?.forceContinue !== undefined) {
          messages.push({
            role: "user",
            content: result.forceContinue,
          });
          continue;
        }
      }
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
