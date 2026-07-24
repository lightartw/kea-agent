import type {
  AssistantMessage,
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
 * Pure function: run the agent loop from a user input.
 * Mutates `messages` in place.
 *
 * Lifecycle:
 *   agent_start → [user_prompt_submit] → user message →
 *   (turn_start → stream → [tools] → turn_end)* → agent_end
 */
export async function* runAgentLoop(
  messages: Message[],
  systemPrompt: string,
  input: string,
  streamFn: StreamFn,
  model: ModelConfig,
  registry: ToolRegistry,
  hooks?: HookRegistry,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  yield { type: "agent_start" };

  // user_prompt_submit — hook can block; failure = blocked
  if (hooks !== undefined) {
    try {
      const result = await hooks.trigger({ type: "user_prompt_submit", prompt: input });
      if (result?.block === true) {
        yield { type: "agent_end", messages: [...messages] };
        return;
      }
    } catch {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }
  }

  messages.push({ role: "user", content: input });

  while (true) {
    // Aborted between turns — exit cleanly
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    yield { type: "turn_start" };

    // pre_turn — before LLM stream, hook can inject context; failure is swallowed
    if (hooks !== undefined && !signal?.aborted) {
      try {
        const result = await hooks.trigger({ type: "pre_turn" });
        if (result?.context !== undefined) {
          messages.push({ role: "user", content: result.context });
        }
      } catch { /* pre_turn is advisory */ }
    }

    // Build Context
    const ctx: Context = {
      ...(systemPrompt ? { systemPrompt } : {}),
      messages,
      tools: registry.schemas(),
    };

    const toolCalls: ToolCall[] = [];
    let turnMessage: AssistantMessage | undefined;

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
        case "done":
          messages.push(event.message);
          turnMessage = event.message;
          break;
        case "error":
          messages.push(event.message);
          yield { type: "turn_end", message: event.message };
          yield { type: "agent_end", messages: [...messages] };
          return;
      }
    }

    yield { type: "turn_end", message: turnMessage! };

    // Aborted during streaming — exit cleanly, skip tools
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    // No tool calls — run stop hook; failure is swallowed
    if (toolCalls.length === 0) {
      if (hooks !== undefined && !signal?.aborted) {
        try {
          const result = await hooks.trigger({ type: "stop", messages: [...messages] });
          if (result?.messages !== undefined) {
            messages.length = 0;
            messages.push(...result.messages);
          }
          if (result?.forceContinue !== undefined) {
            messages.push({ role: "user", content: result.forceContinue });
            continue;
          }
        } catch { /* stop is advisory */ }
      }
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    // Execute tools sequentially — hooks run around each execution
    for (const call of toolCalls) {
      yield { type: "tool_start", call };

      // pre_tool_use — hook can block before execution starts
      let blockReason: string | undefined;
      if (hooks !== undefined && !signal?.aborted) {
        try {
          const hookResult = await hooks.trigger({ type: "pre_tool_use", call });
          if (hookResult?.block === true) blockReason = hookResult.reason ?? "blocked by hook";
        } catch (error) {
          blockReason = error instanceof Error ? error.message : String(error);
        }
      }

      let result;
      if (blockReason !== undefined) {
        result = { content: `Error: ${blockReason}`, isError: true };
      } else if (signal?.aborted) {
        result = { content: "Error: aborted", isError: true };
      } else {
        result = await registry.execute(call);
      }

      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
      yield { type: "tool_end", call, result };

      // post_tool_use — side-effect hooks, failures are swallowed
      if (hooks !== undefined) {
        try {
          await hooks.trigger({ type: "post_tool_use", call, result });
        } catch { /* post hooks are side-effects */ }
      }

      if (signal?.aborted) break;
    }
  }
}
