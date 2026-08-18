import type {
  Context,
  Message,
  StreamChunk,
} from "../ai/types.js";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
} from "./types.js";
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

/**
 * Run one Agent Run from a user input. Complete messages are committed
 * through `context.appendMessage()` before their events are emitted.
 * Events and cancellation come from `context`, which the caller built
 * for this Run.
 */
export async function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
): Promise<void> {
  const run = { sessionId: context.sessionId, runId: context.runId };
  const signal = context.signal;

  // ── agent/user-prompt (intercept) ──
  const prompt = await context.events.intercept(
    "agent/user-prompt",
    { ...run, prompt: input },
    async (value) => value.prompt,
    signal,
  );
  if (prompt === undefined) return;

  await context.appendMessage({ role: "user", content: prompt });

  // ── Main loop ──
  let completedTurns = 0;
  while (true) {
    if (signal?.aborted) return;

    await context.events.emit("agent/turn-start", run);

    // ── agent/context (intercept) ──
    const requestMessages = [...context.messages];
    const effectiveMessages = await context.events.intercept(
      "agent/context",
      { ...run, messages: requestMessages },
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

    for await (const event of streamFn(
      config.model,
      llmContext,
      signal === undefined ? {} : { signal },
    )) {
      aiEventToToolCalls(event, toolCalls);

      switch (event.type) {
        case "text_delta":
          await context.events.emit("agent/text-delta", { ...run, text: event.text });
          break;
        case "thinking_delta":
          await context.events.emit("agent/thinking-delta", { ...run, thinking: event.thinking });
          break;
        case "toolcall_start":
          await context.events.emit("agent/tool-call-start", { ...run, id: event.id, name: event.name });
          break;
        case "toolcall_delta":
          await context.events.emit("agent/tool-call-delta", { ...run, id: event.id, argumentsDelta: event.argumentsDelta });
          break;
        case "toolcall_end":
          break;
        case "done":
          await context.appendMessage(event.message);
          turnMessage = event.message;
          break;
        case "error":
          await context.appendMessage(event.message);
          await context.events.emit("agent/turn-end", {
            ...run,
            message: event.message,
            toolResults: [],
          });
          if (signal?.aborted) return;
          // Surface the failure to the Harness so the Run ends in error
          // instead of silently looking completed.
          throw new Error(event.message.errorMessage ?? "Model stream failed");
      }
    }

    if (turnMessage === undefined) {
      throw new Error("Model stream ended without a done or error terminal chunk");
    }

    // ── Execute Tool Calls in source order; every call produces exactly one result ──
    const toolResults: AgentMessage[] = [];
    for (const call of toolCalls) {
      const toolEvent = { ...run, cwd: context.cwd, call };
      await context.events.emit("agent/tool-call", toolEvent);
      const result = await context.tools.execute(call, {
        sessionId: context.sessionId,
        runId: context.runId,
        cwd: context.cwd,
        events: context.events,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const resultMessage = toToolResultMessage(call, result);
      await context.appendMessage(resultMessage);
      toolResults.push(resultMessage);
      await context.events.emit("agent/tool-result", {
        ...toolEvent,
        result,
      });
    }

    await context.events.emit("agent/turn-end", {
      ...run,
      message: turnMessage,
      toolResults,
    });

    completedTurns += 1;
    if (config.maxTurns !== undefined && completedTurns >= config.maxTurns) {
      return;
    }

    signal?.throwIfAborted();

    // Every Tool Call above produces one Tool Result. Without any results,
    // there is nothing new for the model to consume in another Turn.
    if (toolResults.length === 0) return;
  }
}
