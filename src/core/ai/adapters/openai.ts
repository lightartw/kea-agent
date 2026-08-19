import OpenAI from "openai";

import type { Adapter, ResolvedOptions } from "../factory.js";
import type {
  ContentBlock,
  Context,
  Message,
  StopReason,
  StreamChunk,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolCall,
} from "../types.js";
import { errorMessage } from "../../util/index.js";

// ── Message conversion ──

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

export class OpenAIAdapter implements Adapter {
  private readonly sdk: OpenAI;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.sdk = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  async *stream(
    model: string,
    context: Context,
    options: ResolvedOptions,
  ): AsyncIterable<StreamChunk> {
    const apiMessages: Record<string, unknown>[] = context.systemPrompt
      ? [{ role: "system" as const, content: context.systemPrompt }, ...messagesForOpenAI(context.messages)]
      : messagesForOpenAI(context.messages);

    const started = performance.now();
    let usedModel = model;
    let reasoning = "";
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: StopReason = "stop";
    let thinkingOpen = false;
    let textOpen = false;

    const toolCalls = new Map<number, { id: string; name: string; arguments: string; started: boolean }>();

    try {
      const sdkStream = await this.sdk.chat.completions.create(
        {
          model,
          messages: apiMessages as any,
          ...(context.tools === undefined ? {} : { tools: toolsForOpenAI(context.tools) }),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: options.maxTokens,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.topP === undefined ? {} : { top_p: options.topP }),
          ...(options.stop === undefined ? {} : { stop: [...options.stop] }),
        },
        { timeout: Math.ceil(options.timeout * 1000), signal: options.signal },
      );

      for await (const chunk of sdkStream as any) {
        if (chunk.model) usedModel = chunk.model;
        if (chunk.usage) {
          inputTokens = Number(chunk.usage.prompt_tokens ?? inputTokens);
          outputTokens = Number(chunk.usage.completion_tokens ?? outputTokens);
        }

        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);

          const delta = choice.delta ?? {};

          if (delta.reasoning_content) {
            if (!thinkingOpen) {
              thinkingOpen = true;
              yield { type: "thinking_start" };
            }
            reasoning += delta.reasoning_content;
            yield { type: "thinking_delta", thinking: delta.reasoning_content };
          }

          if (delta.content) {
            if (thinkingOpen) {
              thinkingOpen = false;
              yield { type: "thinking_end" };
            }
            if (!textOpen) {
              textOpen = true;
              yield { type: "text_start" };
            }
            text += delta.content;
            yield { type: "text_delta", text: delta.content };
          }

          for (const [position, call] of (delta.tool_calls ?? []).entries()) {
            if (thinkingOpen) {
              thinkingOpen = false;
              yield { type: "thinking_end" };
            }
            if (textOpen) {
              textOpen = false;
              yield { type: "text_end" };
            }
            const index = call.index ?? position;
            let tc = toolCalls.get(index);
            if (!tc) {
              tc = { id: "", name: "", arguments: "", started: false };
              toolCalls.set(index, tc);
            }

            if (call.id) tc.id = call.id;
            if (call.function?.name) tc.name = call.function.name;

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

      // Some endpoints (e.g. DeepSeek) never send a terminal tool-call chunk;
      // close every started call so the agent loop can collect and run it.
      for (const tc of toolCalls.values()) {
        if (!tc.started) continue;
        yield {
          type: "toolcall_end",
          toolCall: {
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments || "{}"),
          },
        };
      }

      if (thinkingOpen) {
        thinkingOpen = false;
        yield { type: "thinking_end" };
      }
      if (textOpen) {
        textOpen = false;
        yield { type: "text_end" };
      }

      const contentBlocks: ContentBlock[] = [];
      if (reasoning.length > 0) {
        contentBlocks.push({ type: "thinking", thinking: reasoning } as ThinkingBlock);
      }
      if (text.length > 0) {
        contentBlocks.push({ type: "text", text } as TextBlock);
      }
      for (const tc of toolCalls.values()) {
        const args = JSON.parse(tc.arguments || "{}");
        contentBlocks.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: args } as ToolCall);
      }

      yield {
        type: "done",
        message: {
          role: "assistant",
          content: contentBlocks,
          model: usedModel,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          stopReason,
          latencyMs: Math.round(performance.now() - started),
        },
      };
    } catch (err: unknown) {
      yield {
        type: "error",
        message: {
          role: "assistant",
          content: [],
          model: usedModel,
          stopReason: "error",
          errorMessage: errorMessage(err),
          latencyMs: Math.round(performance.now() - started),
        },
      };
    }
  }
}
