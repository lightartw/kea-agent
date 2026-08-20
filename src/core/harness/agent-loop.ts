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
import type { HookContext } from "./events.js";

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

function hookContext(context: AgentContext): HookContext {
  return {
    sessionId: context.sessionId,
    runId: context.runId,
    cwd: context.cwd,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

/**
 * Run one Agent Run from a user input. Complete messages are committed
 * through `context.appendMessage()` before their facts are emitted. Facts go
 * through the Harness observation bus (`context.events`); control goes through
 * the fixed hooks (`context.hooks`).
 */
export async function runAgentLoop(
  input: string,
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
): Promise<void> {
  const signal = context.signal;
  const hooks = hookContext(context);

  signal?.throwIfAborted();

  // ── beforePrompt (control) ──
  const prompt = await context.hooks.beforePrompt(input, hooks);
  if (prompt === undefined) return;

  await context.appendMessage({ role: "user", content: prompt });

  // ── Main loop ──
  let completedTurns = 0;
  while (true) {
    if (signal?.aborted) return;

    await context.events.emit({ type: "turn-start", runId: context.runId });

    // ── transformContext (control) ──
    const effectiveMessages = await context.hooks.transformContext(
      [...context.messages],
      hooks,
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
        case "text_start":
          await context.events.emit({ type: "text-start", runId: context.runId });
          break;
        case "text_end":
          await context.events.emit({ type: "text-end", runId: context.runId });
          break;
        case "thinking_start":
          await context.events.emit({ type: "thinking-start", runId: context.runId });
          break;
        case "thinking_end":
          await context.events.emit({ type: "thinking-end", runId: context.runId });
          break;
        case "text_delta":
          await context.events.emit({ type: "text-delta", runId: context.runId, text: event.text });
          break;
        case "thinking_delta":
          await context.events.emit({ type: "thinking-delta", runId: context.runId, thinking: event.thinking });
          break;
        case "toolcall_start":
          await context.events.emit({ type: "tool-call-start", runId: context.runId, id: event.id, name: event.name });
          break;
        case "toolcall_delta":
          await context.events.emit({ type: "tool-call-delta", runId: context.runId, id: event.id, argumentsDelta: event.argumentsDelta });
          break;
        case "toolcall_end":
          break;
        case "done":
          await context.appendMessage(event.message);
          turnMessage = event.message;
          break;
        case "error":
          await context.appendMessage(event.message);
          await context.events.emit({
            type: "turn-end",
            runId: context.runId,
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
      await context.events.emit({ type: "tool-call", runId: context.runId, cwd: context.cwd, call });
      const result = await context.tools.execute(call, {
        sessionId: context.sessionId,
        runId: context.runId,
        cwd: context.cwd,
        hooks: context.hooks,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const resultMessage = toToolResultMessage(call, result);
      await context.appendMessage(resultMessage);
      toolResults.push(resultMessage);
      await context.events.emit({
        type: "tool-result",
        runId: context.runId,
        cwd: context.cwd,
        call,
        result,
      });
    }

    await context.events.emit({
      type: "turn-end",
      runId: context.runId,
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
