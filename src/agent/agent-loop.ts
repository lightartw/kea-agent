import type {
  AssistantMessageEvent,
  Context,
  Message,
  StreamFn,
} from "../ai/types.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

// ── Helpers (extracted from old loop body) ──

function aiEventToToolCalls(event: AssistantMessageEvent, toolCalls: AgentToolCall[]): void {
  if (event.type === "toolcall_end") {
    toolCalls.push({
      type: "toolCall",
      id: event.toolCall.id,
      name: event.toolCall.name,
      arguments: event.toolCall.arguments,
    });
  }
}

/**
 * Pure function: run the agent loop from a user input.
 * Mutates `context.messages` in place.
 */
export async function* runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  yield { type: "agent_start" };

  // ── onUserPrompt ──
  if (config.onUserPrompt) {
    try {
      const result = await config.onUserPrompt(input);
      if (result?.block) {
        yield { type: "agent_end", messages: [...context.messages] };
        return;
      }
    } catch {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }
  }

  context.messages.push({ role: "user", content: input } as AgentMessage);

  // ── Main loop ──
  while (true) {
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    yield { type: "turn_start" };

    // ── onPreTurn ──
    if (config.onPreTurn && !signal?.aborted) {
      try {
        const result = await config.onPreTurn();
        if (result?.context !== undefined) {
          context.messages.push({ role: "user", content: result.context } as AgentMessage);
        }
      } catch { /* advisory */ }
    }

    // ── convertToLlm boundary ──
    const llmMessages: Message[] = config.convertToLlm(context.messages);
    const llmContext: Context = {
      ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
      messages: llmMessages,
      tools: context.tools.schemas(),
    };

    const toolCalls: AgentToolCall[] = [];
    let turnMessage: AgentMessage | undefined;

    for await (const event of streamFn(config.model, llmContext, signal === undefined ? {} : { signal })) {
      aiEventToToolCalls(event, toolCalls);

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
          yield {
            type: "toolcall_end",
            toolCall: {
              type: "toolCall",
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
            },
          };
          break;
        case "done":
          context.messages.push(event.message as AgentMessage);
          turnMessage = event.message as AgentMessage;
          break;
        case "error":
          context.messages.push(event.message as AgentMessage);
          yield { type: "turn_end", message: event.message as AgentMessage };
          yield { type: "agent_end", messages: [...context.messages] };
          return;
      }
    }

    yield { type: "turn_end", message: turnMessage! };

    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    // ── No tool calls → onStop ──
    if (toolCalls.length === 0) {
      if (config.onStop && !signal?.aborted) {
        try {
          const result = await config.onStop([...context.messages]);
          if (result?.messages !== undefined) {
            context.messages.length = 0;
            context.messages.push(...result.messages);
          }
          if (result?.forceContinue !== undefined) {
            context.messages.push({ role: "user", content: result.forceContinue } as AgentMessage);
            continue;
          }
        } catch { /* advisory */ }
      }
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    // ── Execute tools ──
    for (const call of toolCalls) {
      yield { type: "tool_start", call };

      let blockReason: string | undefined;
      if (config.onBeforeTool && !signal?.aborted) {
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
        result = await context.tools.execute(call);
      }

      context.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      } as AgentMessage);
      yield { type: "tool_end", call, result };

      if (config.onAfterTool) {
        try { await config.onAfterTool(call, result); } catch { /* side-effect */ }
      }

      if (signal?.aborted) break;
    }
  }
}
