import Anthropic from "@anthropic-ai/sdk";

import { mergeOptions } from "../client.js";
import type {
  Context,
  FinishReason,
  LLMClient,
  LLMConfig,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  Message,
  Tool,
  ToolCall,
} from "../types.js";
import { runWithTimeout, timeoutMilliseconds } from "../../utils/timeout.js";

// Anthropic requires system text separately and groups tool results as user content blocks.
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
      if (message.role === "assistant" && message.toolCalls) {
        converted.push({
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
          ],
        });
      } else {
        converted.push({ role: message.role, content: message.content });
      }
    }
  }
  flushResults();
  return converted;
}

function optionsForAnthropic(options: LLMOptions): Record<string, unknown> {
  return {
    max_tokens: options.maxTokens,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { top_p: options.topP }),
    ...(options.stop === undefined ? {} : { stop_sequences: options.stop }),
  };
}

function toolsForAnthropic(tools: readonly Tool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}

function finishReason(reason: string | null | undefined): FinishReason {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return reason === "end_turn" || reason === "stop_sequence" ? "stop" : null;
}

function responseForAnthropic(response: any, latencyMs: number): LLMResponse {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of response.content) {
    if (block.type === "text") content += block.text;
    if (block.type === "tool_use") toolCalls.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input });
  }
  const usage = response.usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  return {
    model: response.model ?? "",
    content: content || null,
    toolCalls,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    latencyMs,
    finishReason: finishReason(response.stop_reason),
  };
}

/** Anthropic implementation of the common LLMClient interface. */
export class AnthropicAdapter implements LLMClient {
  private readonly sdk: Anthropic;

  constructor(private readonly config: LLMConfig) {
    this.sdk = new Anthropic({ apiKey: config.apiKey, ...(config.baseUrl === null ? {} : { baseURL: config.baseUrl }) });
  }

  async invoke(
    context: Context,
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse> {
      const opts = mergeOptions(this.config.options, options);
      const converted = messagesForAnthropic(context.messages);
      const started = performance.now();
      const response = await runWithTimeout(opts.timeout, (signal) =>
        this.sdk.messages.create(
          {
            model: this.config.model,
            messages: converted as any,
            ...(context.systemPrompt === undefined ? {} : { system: context.systemPrompt }),
            ...(context.tools === undefined ? {} : { tools: toolsForAnthropic(context.tools) as any }),
            ...optionsForAnthropic(opts),
          } as any,
          { timeout: timeoutMilliseconds(opts.timeout), signal },
        ),
      );
      return responseForAnthropic(response, Math.round(performance.now() - started));
  }

  async *stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent> {
      const opts = mergeOptions(this.config.options, options);
      const converted = messagesForAnthropic(context.messages);
      const signal = AbortSignal.timeout(timeoutMilliseconds(opts.timeout));
      const stream = await this.sdk.messages.create(
        {
          model: this.config.model,
          messages: converted as any,
          ...(context.systemPrompt === undefined ? {} : { system: context.systemPrompt }),
          ...(context.tools === undefined ? {} : { tools: toolsForAnthropic(context.tools) as any }),
          stream: true,
          ...optionsForAnthropic(opts),
        } as any,
        { timeout: timeoutMilliseconds(opts.timeout), signal },
      );

      const started = performance.now();
      let model = this.config.model;
      let content = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let reason: FinishReason = null;
      const pending = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const event of stream as any) {
        if (event.type === "message_start") {
          model = event.message.model ?? model;
          inputTokens = Number(event.message.usage?.input_tokens ?? 0);
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          pending.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: Object.keys(event.content_block.input ?? {}).length ? JSON.stringify(event.content_block.input) : "",
          });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            content += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const call = pending.get(event.index);
            if (call) call.arguments += event.delta.partial_json;
          }
        } else if (event.type === "message_delta") {
          reason = finishReason(event.delta.stop_reason) ?? reason;
          outputTokens = Number(event.usage?.output_tokens ?? outputTokens);
        }
      }
      yield {
        type: "response_done",
        response: {
          model,
          content: content || null,
          toolCalls: [...pending.values()].map((call) => ({ type: "toolCall" as const, ...call, arguments: JSON.parse(call.arguments || "{}") })),
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          latencyMs: Math.round(performance.now() - started),
          finishReason: reason,
        },
      };
  }
}
