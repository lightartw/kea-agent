import Anthropic from "@anthropic-ai/sdk";

import type { Adapter, ResolvedOptions } from "../factory.js";
import type {
  AssistantMessageEvent,
  ContentBlock,
  Context,
  Message,
  StopReason,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolCall,
} from "../types.js";
import { mergeSignals } from "../../utils/timeout.js";

// ── Message conversion ──

function messagesForAnthropic(messages: readonly Message[]): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  const flushResults = (): void => {
    if (results.length) converted.push({ role: "user", content: results.splice(0) });
  };

  for (const message of messages) {
    if (message.role === "tool") {
      results.push({ type: "tool_result", tool_use_id: message.toolCallId, content: message.content });
    } else {
      flushResults();
      if (message.role === "assistant") {
        const blocks: Record<string, unknown>[] = [];
        for (const block of message.content) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "toolCall") {
            blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
          }
        }
        if (blocks.length > 0) {
          converted.push({ role: "assistant", content: blocks });
        }
      } else {
        converted.push({ role: "user", content: message.content });
      }
    }
  }
  flushResults();
  return converted;
}

// ── Conversion helpers ──

function toolsForAnthropic(tools: readonly Tool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "toolUse";
  if (reason === "max_tokens") return "length";
  return reason === "end_turn" || reason === "stop_sequence" ? "stop" : "error";
}

// ── Adapter ──

export class AnthropicAdapter implements Adapter {
  private readonly sdk: Anthropic;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.sdk = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  async *stream(
    model: string,
    context: Context,
    options: ResolvedOptions,
  ): AsyncIterable<AssistantMessageEvent> {
    const converted = messagesForAnthropic(context.messages);
    const signal = mergeSignals(options.timeout, options.signal);

    type PendingBlock =
      | { kind: "text"; text: string }
      | { kind: "thinking"; thinking: string; signature?: string }
      | { kind: "toolCall"; id: string; name: string; arguments: string };

    const started = performance.now();
    let usedModel = model;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: StopReason = "stop";
    const pending = new Map<number, PendingBlock>();

    try {
      const sdkStream = await this.sdk.messages.create(
        {
          model,
          messages: converted as any,
          ...(context.systemPrompt === undefined ? {} : { system: context.systemPrompt }),
          ...(context.tools === undefined ? {} : { tools: toolsForAnthropic(context.tools) as any }),
          stream: true,
          max_tokens: options.maxTokens,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.topP === undefined ? {} : { top_p: options.topP }),
          ...(options.stop === undefined ? {} : { stop_sequences: options.stop }),
        } as any,
        { timeout: Math.ceil(options.timeout * 1000), signal },
      );

      for await (const event of sdkStream as any) {
        switch (event.type) {
          case "message_start":
            usedModel = event.message?.model ?? usedModel;
            inputTokens = Number(event.message?.usage?.input_tokens ?? 0);
            break;

          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              pending.set(event.index, {
                kind: "toolCall",
                id: block.id,
                name: block.name,
                arguments: Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : "",
              });
              yield { type: "toolcall_start", id: block.id, name: block.name };
            } else if (block.type === "thinking") {
              pending.set(event.index, { kind: "thinking", thinking: block.thinking ?? "" });
            } else {
              pending.set(event.index, { kind: "text", text: block.text ?? "" });
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            const block = pending.get(event.index);
            if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
              if (block && block.kind === "text") block.text += delta.text;
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking_delta", thinking: delta.thinking };
              if (block && block.kind === "thinking") block.thinking += delta.thinking;
            } else if (delta.type === "input_json_delta") {
              yield { type: "toolcall_delta", id: block && block.kind === "toolCall" ? block.id : "", argumentsDelta: delta.partial_json };
              if (block && block.kind === "toolCall") block.arguments += delta.partial_json;
            }
            break;
          }

          case "content_block_stop": {
            const block = pending.get(event.index);
            if (block && block.kind === "toolCall") {
              const args = JSON.parse(block.arguments || "{}");
              const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: args };
              yield { type: "toolcall_end", toolCall };
            }
            if (block && block.kind === "thinking" && (event as any).content_block?.signature) {
              block.signature = (event as any).content_block.signature;
            }
            break;
          }

          case "message_delta":
            stopReason = mapStopReason(event.delta?.stop_reason ?? event.usage?.stop_reason);
            outputTokens = Number(event.usage?.output_tokens ?? outputTokens);
            break;
        }
      }

      const contentBlocks: ContentBlock[] = [];
      for (const block of pending.values()) {
        if (block.kind === "text" && block.text.length > 0) {
          contentBlocks.push({ type: "text", text: block.text } as TextBlock);
        } else if (block.kind === "thinking" && block.thinking.length > 0) {
          contentBlocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature } as ThinkingBlock);
        } else if (block.kind === "toolCall") {
          contentBlocks.push({ type: "toolCall", id: block.id, name: block.name, arguments: JSON.parse(block.arguments || "{}") } as ToolCall);
        }
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
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - started),
        },
      };
    }
  }
}
