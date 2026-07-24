import OpenAI from "openai";

import type {
  AssistantMessageEvent,
  ContentBlock,
  Context,
  LLMClient,
  LLMConfig,
  LLMOptions,
  Message,
  StopReason,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolCall,
} from "../types.js";
import { timeoutMilliseconds } from "../../utils/timeout.js";

// ── Message conversion ──

/** Convert internal Message[] to OpenAI's format.
 *  v2: AssistantMessage.content is ContentBlock[] — map each block to its OpenAI equivalent. */
function messagesForOpenAI(messages: readonly Message[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.arguments) },
          });
        }
        // thinking blocks are not re-sent
      }
      return {
        role: "assistant",
        content: textParts.join("") || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: "user", content: message.content };
  });
}

// ── Conversion helpers ──

function toolsForOpenAI(tools: readonly Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Record<string, unknown> },
  }));
}

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "error";
  return reason === "stop" ? "stop" : "stop";
}

// ── Adapter ──

/** OpenAI implementation of the v2 stream-only LLMClient interface. */
export class OpenAIAdapter implements LLMClient {
  private readonly sdk: OpenAI;

  constructor(private readonly config: LLMConfig) {
    this.sdk = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === null ? {} : { baseURL: config.baseUrl }),
    });
  }

  async *stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<AssistantMessageEvent> {
    const opts: LLMOptions = { ...this.config.options, ...options };
    const apiMessages: Record<string, unknown>[] = context.systemPrompt
      ? [{ role: "system" as const, content: context.systemPrompt }, ...messagesForOpenAI(context.messages)]
      : messagesForOpenAI(context.messages);

    const started = performance.now();
    let model = this.config.model;
    let reasoning = "";
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: StopReason = "stop";

    // Track tool calls: index → { id, name, arguments }
    const toolCalls = new Map<number, { id: string; name: string; arguments: string; started: boolean }>();

    try {
      const sdkStream = await this.sdk.chat.completions.create(
        {
          model: this.config.model,
          messages: apiMessages as any,
          ...(context.tools === undefined ? {} : { tools: toolsForOpenAI(context.tools) }),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: opts.maxTokens,
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          ...(opts.topP === undefined ? {} : { top_p: opts.topP }),
          ...(opts.stop === undefined ? {} : { stop: [...opts.stop] }),
        },
        { timeout: timeoutMilliseconds(opts.timeout) },
      );

      for await (const chunk of sdkStream as any) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          inputTokens = Number(chunk.usage.prompt_tokens ?? inputTokens);
          outputTokens = Number(chunk.usage.completion_tokens ?? outputTokens);
        }

        for (const choice of chunk.choices ?? []) {
          // Track finish reason
          if (choice.finish_reason) {
            stopReason = mapStopReason(choice.finish_reason);
          }

          const delta = choice.delta ?? {};

          // Thinking / reasoning content
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            yield { type: "thinking_delta", thinking: delta.reasoning_content };
          }

          // Text content
          if (delta.content) {
            text += delta.content;
            yield { type: "text_delta", text: delta.content };
          }

          // Tool calls
          for (const [position, call] of (delta.tool_calls ?? []).entries()) {
            const index = call.index ?? position;
            let tc = toolCalls.get(index);
            if (!tc) {
              tc = { id: "", name: "", arguments: "", started: false };
              toolCalls.set(index, tc);
            }

            if (call.id) tc.id = call.id;
            if (call.function?.name) tc.name = call.function.name;

            // First time we have both id and name → toolcall_start
            if (!tc.started && tc.id && tc.name) {
              tc.started = true;
              yield { type: "toolcall_start", id: tc.id, name: tc.name };
            }

            if (call.function?.arguments) {
              tc.arguments += call.function.arguments;
              yield { type: "toolcall_delta", id: tc.id, argumentsDelta: call.function.arguments };
            }
          }
        }
      }

      // Build ContentBlock[] from accumulated state
      const contentBlocks: ContentBlock[] = [];

      if (reasoning.length > 0) {
        contentBlocks.push({ type: "thinking", thinking: reasoning } as ThinkingBlock);
      }
      if (text.length > 0) {
        contentBlocks.push({ type: "text", text } as TextBlock);
      }

      // Yield toolcall_end for each completed tool call, then add to contentBlocks
      for (const tc of toolCalls.values()) {
        const args = JSON.parse(tc.arguments || "{}");
        const toolCall: ToolCall = { type: "toolCall", id: tc.id, name: tc.name, arguments: args };
        yield { type: "toolcall_end", toolCall };
        contentBlocks.push(toolCall);
      }

      const latencyMs = Math.round(performance.now() - started);
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: contentBlocks,
          model,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          stopReason,
          latencyMs,
        },
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        message: {
          role: "assistant",
          content: [],
          model,
          stopReason: "error",
          errorMessage: message,
          latencyMs,
        },
      };
    }
  }
}
