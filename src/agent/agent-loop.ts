import type {
  Context,
  Message,
  ModelConfig,
  StreamFn,
  ToolCall,
} from "../ai/types.js";
import type { HookRegistry } from "./hooks/registry.js";
import type { AgentEvent } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * Pure function: run the agent loop over the given message array.
 * Mutates `messages` in place so Agent owns the history while the loop
 * only appends assistant + tool messages.
 *
 * Lifecycle: agent_start → (turn_start → stream → [tools] → turn_end)* → agent_end
 */
export async function* runAgentLoop(
  messages: Message[],
  systemPrompt: string,
  streamFn: StreamFn,
  model: ModelConfig,
  registry: ToolRegistry,
  hooks?: HookRegistry,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  yield { type: "agent_start" };

  while (true) {
    // Aborted between turns — exit cleanly
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    yield { type: "turn_start" };

    // pre_turn — before LLM stream, hooks can inject context
    if (hooks !== undefined && !signal?.aborted) {
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
    let forceContinue = false;

    // Stream consumption — signal propagates to the HTTP request via StreamOptions
    for await (const event of streamFn(model, ctx, signal === undefined ? {} : { signal })) {
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
          messages.push(message);

          if (toolCalls.length === 0) {
            // stop hook
            if (hooks !== undefined && !signal?.aborted) {
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
                yield { type: "turn_end", message };
                forceContinue = true;
                break;
              }
            }
            yield { type: "turn_end", message };
            yield { type: "agent_end", messages: [...messages] };
            return;
          }
          yield { type: "turn_end", message };
          break; // fall through to tool execution
        }
        case "error": {
          messages.push(event.message);
          yield { type: "turn_end", message: event.message };
          yield { type: "agent_end", messages: [...messages] };
          return;
        }
      }
    }

    // forceContinue skips tool execution and goes back to turn_start
    if (forceContinue) continue;

    // Aborted during streaming — skip tool execution, exit cleanly
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    // Execute tools sequentially
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
      // Aborted mid-batch — stop executing remaining tools
      if (signal?.aborted) break;
    }
  }
}
