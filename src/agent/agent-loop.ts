import type {
  Context,
  LLMClient,
  Message,
  ToolCall,
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
  systemPrompt: string,
  client: LLMClient,
  registry: ToolRegistry,
  hooks?: HookRegistry,
): AsyncIterable<AgentEvent> {
  while (true) {
    // pre_turn — before LLM stream, hooks can inject context.
    if (hooks !== undefined) {
      const result = await hooks.trigger({ type: "pre_turn" });
      if (result?.context !== undefined) {
        messages.push({ role: "user", content: result.context });
      }
    }

    // Build Context
    const ctx: Context = {
      ...(systemPrompt ? { systemPrompt } : {}),
      messages,
      tools: registry.schemas(),
    };

    const toolCalls: ToolCall[] = [];

    // Stream consumption loop
    for await (const event of client.stream(ctx)) {
      switch (event.type) {
        case "text_delta":
          yield { type: "text_delta", text: event.text };
          break;
        case "thinking_delta":
          yield { type: "thinking_delta", thinking: event.thinking };
          break;
        case "toolcall_start":
          yield { type: "toolcall_start", id: event.id, name: event.name };
          break;
        case "toolcall_delta":
          yield { type: "toolcall_delta", id: event.id, argumentsDelta: event.argumentsDelta };
          break;
        case "toolcall_end":
          toolCalls.push(event.toolCall);
          yield { type: "toolcall_end", toolCall: event.toolCall };
          break;
        case "done": {
          const message = event.message;
          messages.push(message); // AssistantMessage goes directly into history
          if (toolCalls.length === 0) {
            // stop hook
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
            yield { type: "turn_end", message };
            return;
          }
          break; // fall through to tool execution
        }
        case "error": {
          messages.push(event.message);
          yield { type: "turn_end", message: event.message };
          return;
        }
      }
    }

    // Execute tools
    for (const call of toolCalls) {
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
