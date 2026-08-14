import type {
  Context,
  Message,
  StreamChunk,
  StreamFn,
} from "../ai/types.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

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

function shouldContinue(
  toolResults: readonly AgentMessage[],
  signal?: AbortSignal,
): boolean {
  return !signal?.aborted && toolResults.length > 0;
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
  // ── agent/user-prompt (intercept) ──
  const prompt = await config.events.intercept(
    "agent/user-prompt",
    { ...config.run, prompt: input },
    async (value) => value.prompt,
    signal,
  );
  if (prompt === undefined) return;

  await context.appendMessage({ role: "user", content: input });

  // ── Main loop ──
  while (true) {
    if (signal?.aborted) return;

    await config.events.emit("agent/turn-start", config.run);

    // ── agent/context (intercept) ──
    const requestMessages = [...context.messages];
    const effectiveMessages = await config.events.intercept(
      "agent/context",
      { ...config.run, messages: requestMessages },
      async (value) => value.messages,
      signal,
    );
    const llmMessages: readonly Message[] = config.convertToLlm(effectiveMessages);
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
          await config.events.emit("agent/tool-call-start", { ...config.run, id: event.id, name: event.name });
          break;
        case "toolcall_delta":
          await config.events.emit("agent/tool-call-delta", { ...config.run, id: event.id, argumentsDelta: event.argumentsDelta });
          break;
        case "toolcall_end":
          break;
        case "done":
          await context.appendMessage(event.message);
          turnMessage = event.message;
          break;
        case "error":
          await context.appendMessage(event.message);
          await config.events.emit("agent/turn-end", {
            ...config.run,
            message: event.message,
            toolResults: [],
          });
          return;
      }
    }

    if (turnMessage === undefined) {
      throw new Error("Model stream ended without a done or error terminal chunk");
    }

    // ── Execute Tool Calls in source order; every call produces exactly one result ──
    const toolResults: AgentMessage[] = [];
    for (const call of toolCalls) {
      await config.events.emit("agent/tool-call", { ...config.run, call });
      const result = await context.tools.execute(call, config.events, signal);
      const resultMessage = toToolResultMessage(call, result);
      await context.appendMessage(resultMessage);
      toolResults.push(resultMessage);
      await config.events.emit("agent/tool-result", {
        ...config.run,
        call,
        result,
      });
    }

    await config.events.emit("agent/turn-end", {
      ...config.run,
      message: turnMessage,
      toolResults,
    });

    // ── Decide whether to continue with another Turn ──
    if (!shouldContinue(toolResults, signal)) {
      const continueWith = await config.events.intercept(
        "agent/stopping",
        { ...config.run, messages: [...context.messages] },
        async () => undefined,
        signal,
      );
      if (continueWith === undefined) return;
      await context.appendMessage(continueWith);
      continue;
    }
  }
}
