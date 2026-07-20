import type { LLMCallOptions, LLMClient } from "./llm-client/client.js";
import { LLMProviderError } from "./llm-client/errors.js";
import type {
  AssistantMessage,
  LLMResponse,
  Message,
} from "./llm-client/models.js";
import type { ToolRegistry } from "./tools/registry.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function agentLoop(
  messages: Message[],
  client: LLMClient,
  registry: ToolRegistry,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const callOptions: LLMCallOptions | undefined =
    signal === undefined ? undefined : { signal };

  while (true) {
    const response = await client.invokeWithTools(
      messages,
      registry.schemas(),
      callOptions,
    );
    for (const call of response.toolCalls) {
      if (!isRecord(call.arguments)) {
        throw new LLMProviderError(
          `Tool call arguments must be an object for '${call.name}'`,
        );
      }
    }

    const assistantMessage: AssistantMessage =
      response.toolCalls.length > 0
        ? {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls,
          }
        : { role: "assistant", content: response.content ?? "" };
    messages.push(assistantMessage);

    if (response.toolCalls.length === 0) return response;

    for (const call of response.toolCalls) {
      console.log(
        `\u001b[33m$ ${call.name}: ${JSON.stringify(call.arguments)}\u001b[0m`,
      );
      const result = await registry.execute(call.name, call.arguments, signal);
      console.log(result.content.slice(0, 200));
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
    }
  }
}
