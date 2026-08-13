import type {
  AssistantMessageEvent,
  Context,
  Message,
  StreamFn,
} from "../ai/types.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

// ── Helpers ──

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

  // ── user_prompt hook ──
  const userPromptResult = await config.hooks.trigger({ type: "user_prompt", prompt: input }, signal);
  if (userPromptResult?.block === true) {
    yield { type: "agent_end", messages: [...context.messages] };
    return;
  }

  context.messages.push({ role: "user", content: input } as AgentMessage);

  // ── Main loop ──
  while (true) {
    if (signal?.aborted) {
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    yield { type: "turn_start" };

    // ── context transform hook ──
    const requestMessages = [...context.messages];
    const contextResult = await config.hooks.trigger(
      { type: "context", messages: requestMessages },
      signal,
    );
    const llmMessages: Message[] = config.convertToLlm(
      contextResult?.messages ?? requestMessages,
    );
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

    // ── No tool calls → stop check and maybe done ──
    if (toolCalls.length === 0) {
      const stopResult = await config.hooks.trigger(
        { type: "stop", messages: [...context.messages] },
        signal,
      );
      if (stopResult?.continueWith !== undefined) {
        context.messages.push(stopResult.continueWith);
        continue;
      }
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    // ── Execute tools ──
    for (const call of toolCalls) {
      yield { type: "tool_start", call };

      let blockReason: string | undefined;
      if (!signal?.aborted) {
        try {
          const blockResult = await config.hooks.trigger({
            type: "tool_call",
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments as Record<string, unknown>,
          }, signal);
          if (blockResult?.block === true) {
            blockReason = blockResult.reason ?? "blocked";
          }
        } catch (error) {
          // Exception in hook handler → block the tool (safe default)
          blockReason = `tool_call hook failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      let result: AgentToolResult;
      if (blockReason !== undefined) {
        result = { content: `Error: ${blockReason}`, isError: true };
      } else if (signal?.aborted) {
        result = { content: "Error: aborted", isError: true };
      } else {
        const preparation = context.tools.prepare(call);
        result = preparation.kind === "ready"
          ? await context.tools.execute(preparation.prepared)
          : preparation.result;
      }

      // ── tool_result hook (before history + tool_end) ──
      if (!signal?.aborted) {
        try {
          const patch = await config.hooks.trigger({
            type: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments as Record<string, unknown>,
            content: result.content,
            isError: result.isError,
          }, signal);
          if (patch !== undefined) {
            result = {
              content: patch.content ?? result.content,
              isError: patch.isError ?? result.isError,
            };
          }
        } catch (error) {
          result = {
            content: `Error: tool_result hook failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      }

      // Store final result in history, then yield tool_end with same result
      context.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        isError: result.isError,
      } as AgentMessage);
      yield { type: "tool_end", call, result };

      if (signal?.aborted) break;
    }
  }
}
