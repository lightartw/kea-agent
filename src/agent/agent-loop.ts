import type {
  AssistantMessage,
  Context,
  Message,
  ModelConfig,
  StreamFn,
  ToolCall,
} from "../ai/types.js";
import type { AgentEvent, AgentLoopConfig } from "./types.js";
import type { AgentToolRegistry } from "./tools/registry.js";
import type { AgentToolResult } from "./tools/types.js";

/**
 * Pure function: run the agent loop from a user input.
 * Mutates `messages` in place.
 */
export async function* runAgentLoop(
  messages: Message[],
  systemPrompt: string,
  input: string,
  streamFn: StreamFn,
  model: ModelConfig,
  registry: AgentToolRegistry,
  config?: AgentLoopConfig,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  yield { type: "agent_start" };

  // onUserPrompt
  if (config?.onUserPrompt) {
    try {
      const result = await config.onUserPrompt(input);
      if (result?.block) {
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
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    yield { type: "turn_start" };

    // onPreTurn
    if (config?.onPreTurn && !signal?.aborted) {
      try {
        const result = await config.onPreTurn();
        if (result?.context !== undefined) {
          messages.push({ role: "user", content: result.context });
        }
      } catch { /* advisory */ }
    }

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

    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    // No tool calls — onStop
    if (toolCalls.length === 0) {
      if (config?.onStop && !signal?.aborted) {
        try {
          const result = await config.onStop([...messages]);
          if (result?.messages !== undefined) {
            messages.length = 0;
            messages.push(...result.messages);
          }
          if (result?.forceContinue !== undefined) {
            messages.push({ role: "user", content: result.forceContinue });
            continue;
          }
        } catch { /* advisory */ }
      }
      yield { type: "agent_end", messages: [...messages] };
      return;
    }

    // Execute tools
    for (const call of toolCalls) {
      yield { type: "tool_start", call };

      let blockReason: string | undefined;
      if (config?.onBeforeTool && !signal?.aborted) {
        try {
          const r = await config.onBeforeTool(call);
          if (r?.block) blockReason = r.reason ?? "blocked";
        } catch (error) {
          blockReason = error instanceof Error ? error.message : String(error);
        }
      }

      let result: AgentToolResult;
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

      if (config?.onAfterTool) {
        try { await config.onAfterTool(call, result); } catch { /* side-effect */ }
      }

      if (signal?.aborted) break;
    }
  }
}
