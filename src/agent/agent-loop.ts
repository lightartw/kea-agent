import type {
  Context,
  Message,
  StreamChunk,
  StreamFn,
} from "../ai/types.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, ToolRejectedReason } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { ToolCallDecision } from "./events.js";

// ── Helpers ──

function aiEventToToolCalls(event: StreamChunk, toolCalls: AgentToolCall[]): void {
  if (event.type === "toolcall_end") {
    toolCalls.push({
      type: "toolCall",
      id: event.toolCall.id,
      name: event.toolCall.name,
      arguments: event.toolCall.arguments,
    });
  }
}

function toToolResultMessage(
  call: AgentToolCall,
  result: AgentToolResult,
): AgentMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result.content,
    ...(result.details === undefined ? {} : { details: result.details }),
    isError: result.isError,
  };
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

  // ── agent/user-prompt (ask) ──
  const userPromptResult = await config.events.ask(
    "agent/user-prompt",
    { ...config.run, prompt: input },
    signal,
  );
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

    // ── agent/context (transform) ──
    const requestMessages = [...context.messages];
    const contextResult = await config.events.transform(
      "agent/context",
      { ...config.run, messages: requestMessages },
      signal,
    );
    const llmMessages: Message[] = config.convertToLlm(
      contextResult.messages as AgentMessage[],
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

    // ── No tool calls → stop check and maybe done ──
    if (toolCalls.length === 0) {
      if (signal?.aborted) {
        yield { type: "agent_end", messages: [...context.messages] };
        return;
      }
      const stopResult = await config.events.ask(
        "agent/stop",
        { ...config.run, messages: [...context.messages] },
        signal,
      );
      if (stopResult?.continueWith !== undefined) {
        context.messages.push(stopResult.continueWith);
        continue;
      }
      yield { type: "agent_end", messages: [...context.messages] };
      return;
    }

    // ── Execute tools; synthesize a terminal result even when aborted ──
    for (const originalCall of toolCalls) {
      let result: AgentToolResult;
      let reason: ToolRejectedReason | undefined;
      let effectiveCall: AgentToolCall = originalCall;
      let effectiveArguments: Readonly<Record<string, unknown>> | undefined;

      if (signal?.aborted) {
        reason = "aborted";
        result = { content: "Error: aborted", isError: true };
      } else {
        const decision: ToolCallDecision = {
          ...config.run,
          kind: "execute",
          call: { ...originalCall, arguments: structuredClone(originalCall.arguments) },
        };
        try {
          const finalDecision = await config.events.transform(
            "agent/tool-call",
            decision,
            signal,
          );

          if (signal?.aborted) {
            // Abort wins over a late listener answer.
            reason = "aborted";
            result = { content: "Error: aborted", isError: true };
          } else if (finalDecision.kind === "reject") {
            reason = "blocked";
            result = { content: `Error: ${finalDecision.reason}`, isError: true };
            effectiveArguments = finalDecision.call.arguments;
          } else {
            effectiveCall = finalDecision.call;
            const preparation = context.tools.prepare(effectiveCall);
            if (preparation.kind === "rejected") {
              reason = preparation.reason;
              result = preparation.result;
              effectiveArguments = effectiveCall.arguments;
            } else {
              yield { type: "tool_start", call: effectiveCall };
              result = await context.tools.execute(preparation.prepared, signal);

              if (!signal?.aborted) {
                try {
                  const transformed = await config.events.transform(
                    "agent/tool-result",
                    { ...config.run, call: effectiveCall, result },
                    signal,
                  );
                  result = transformed.result;
                } catch (error) {
                  result = {
                    content: `Error: tool_result listener failed: ${error instanceof Error ? error.message : String(error)}`,
                    isError: true,
                  };
                }
              }
            }
          }
        } catch (error) {
          if (signal?.aborted) {
            reason = "aborted";
            result = { content: "Error: aborted", isError: true };
          } else {
            reason = "blocked";
            result = {
              content: `Error: tool_call listener failed: ${error instanceof Error ? error.message : String(error)}`,
              isError: true,
            };
          }
        }
      }

      context.messages.push(toToolResultMessage(originalCall, result));

      if (reason === undefined) {
        yield { type: "tool_end", call: effectiveCall, result };
      } else {
        yield {
          type: "tool_rejected",
          call: originalCall,
          ...(effectiveArguments === undefined ? {} : { effectiveArguments }),
          result,
          reason,
        };
      }
    }
  }
}
