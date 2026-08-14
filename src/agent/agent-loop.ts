import type {
  Context,
  Message,
  StreamChunk,
  StreamFn,
} from "../ai/types.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { ToolCallDecision, ToolRejectedReason } from "./events.js";

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
 * Run one Agent Run from a user input. Complete messages are committed
 * through `context.appendMessage()` before their facts are emitted.
 */
export async function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): Promise<void> {
  // ── agent/user-prompt (ask) ──
  const userPromptResult = await config.events.ask(
    "agent/user-prompt",
    { ...config.run, prompt: input },
    signal,
  );
  if (userPromptResult?.block === true) return;

  await context.appendMessage({ role: "user", content: input });

  // ── Main loop ──
  while (true) {
    if (signal?.aborted) return;

    await config.events.emit("agent/turn-start", config.run);

    // ── agent/context (transform) ──
    const requestMessages = [...context.messages];
    const contextResult = await config.events.transform(
      "agent/context",
      { ...config.run, messages: requestMessages },
      signal,
    );
    const llmMessages: readonly Message[] = config.convertToLlm(
      contextResult.messages,
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
          await config.events.emit("agent/text-delta", { ...config.run, text: event.text });
          break;
        case "thinking_delta":
          await config.events.emit("agent/thinking-delta", { ...config.run, thinking: event.thinking });
          break;
        case "toolcall_start":
          await config.events.emit("agent/toolcall-start", { ...config.run, id: event.id, name: event.name });
          break;
        case "toolcall_delta":
          await config.events.emit("agent/toolcall-delta", { ...config.run, id: event.id, argumentsDelta: event.argumentsDelta });
          break;
        case "toolcall_end":
          await config.events.emit("agent/toolcall-end", {
            ...config.run,
            toolCall: {
              type: "toolCall",
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
            },
          });
          break;
        case "done":
          await context.appendMessage(event.message);
          turnMessage = event.message;
          break;
        case "error":
          await context.appendMessage(event.message);
          await config.events.emit("agent/turn-end", { ...config.run, message: event.message });
          return;
      }
    }

    if (turnMessage === undefined) {
      throw new Error("Model stream ended without a done or error terminal chunk");
    }
    await config.events.emit("agent/turn-end", { ...config.run, message: turnMessage });

    // ── No tool calls → stop check and maybe done ──
    if (toolCalls.length === 0) {
      if (signal?.aborted) return;
      const stopResult = await config.events.ask(
        "agent/stop",
        { ...config.run, messages: [...context.messages] },
        signal,
      );
      if (stopResult?.continueWith !== undefined) {
        await context.appendMessage(stopResult.continueWith);
        continue;
      }
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
              await config.events.emit("agent/tool-start", { ...config.run, call: effectiveCall });
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

      await context.appendMessage(toToolResultMessage(originalCall, result));

      if (reason === undefined) {
        await config.events.emit("agent/tool-end", { ...config.run, call: effectiveCall, result });
      } else {
        await config.events.emit("agent/tool-rejected", {
          ...config.run,
          call: originalCall,
          ...(effectiveArguments === undefined ? {} : { effectiveArguments }),
          result,
          reason,
        });
      }
    }
  }
}
