import OpenAI from "openai";

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

// OpenAI differs from our history only around tool calls: its arguments are JSON text.
function messagesForOpenAI(messages: readonly Message[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

function optionsForOpenAI(options: LLMOptions): Record<string, unknown> {
  return {
    max_tokens: options.maxTokens,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { top_p: options.topP }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  };
}

function finishReason(reason: string | null | undefined): FinishReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === "length") return "length";
  return reason === "stop" ? "stop" : null;
}

function callsForOpenAI(calls: any[] = []): ToolCall[] {
  return calls.map((call) => ({
    type: "toolCall" as const,
    id: call.id,
    name: call.function.name,
    arguments: JSON.parse(call.function.arguments || "{}"),
  }));
}

function responseForOpenAI(response: any, latencyMs: number): LLMResponse {
  const choice = response.choices[0];
  const usage = response.usage ?? {};
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  return {
    model: response.model ?? "",
    content: choice.message.content || null,
    toolCalls: callsForOpenAI(choice.message.tool_calls),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: Number(usage.total_tokens ?? inputTokens + outputTokens),
    },
    latencyMs,
    finishReason: finishReason(choice.finish_reason),
  };
}

/** OpenAI implementation of the common LLMClient interface. */
export class OpenAIAdapter implements LLMClient {
  private readonly sdk: OpenAI;

  constructor(private readonly config: LLMConfig) {
    this.sdk = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === null ? {} : { baseURL: config.baseUrl }),
    });
  }

  async invoke(
    context: Context,
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse> {
      const opts = mergeOptions(this.config.options, options);
      const timeout = timeoutMilliseconds(opts.timeout);
      const started = performance.now();
      const apiMessages: Record<string, unknown>[] = context.systemPrompt
        ? [{ role: "system" as const, content: context.systemPrompt }, ...messagesForOpenAI(context.messages)]
        : messagesForOpenAI(context.messages);
      const response = await runWithTimeout(opts.timeout, (signal) =>
        this.sdk.chat.completions.create(
          {
            model: this.config.model,
            messages: apiMessages as any,
            ...(context.tools === undefined ? {} : { tools: context.tools as any }),
            ...optionsForOpenAI(opts),
          },
          { timeout, signal },
        ),
      );
      return responseForOpenAI(response, Math.round(performance.now() - started));
  }

  async *stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent> {
      const opts = mergeOptions(this.config.options, options);
      const signal = AbortSignal.timeout(timeoutMilliseconds(opts.timeout));
      const apiMessages: Record<string, unknown>[] = context.systemPrompt
        ? [{ role: "system" as const, content: context.systemPrompt }, ...messagesForOpenAI(context.messages)]
        : messagesForOpenAI(context.messages);
      const stream = await this.sdk.chat.completions.create(
        {
          model: this.config.model,
          messages: apiMessages as any,
          ...(context.tools === undefined ? {} : { tools: context.tools as any }),
          stream: true,
          stream_options: { include_usage: true },
          ...optionsForOpenAI(opts),
        },
        { timeout: timeoutMilliseconds(opts.timeout), signal },
      );

      const started = performance.now();
      let model = this.config.model;
      let content = "";
      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let reason: FinishReason = null;
      const pending = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream as any) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          const inputTokens = Number(chunk.usage.prompt_tokens ?? 0);
          const outputTokens = Number(chunk.usage.completion_tokens ?? 0);
          usage = { inputTokens, outputTokens, totalTokens: Number(chunk.usage.total_tokens ?? inputTokens + outputTokens) };
        }
        for (const choice of chunk.choices ?? []) {
          reason = finishReason(choice.finish_reason) ?? reason;
          if (choice.delta?.content) {
            content += choice.delta.content;
            yield { type: "text_delta", text: choice.delta.content };
          }
          for (const [position, call] of (choice.delta?.tool_calls ?? []).entries()) {
            const index = call.index ?? position;
            const value = pending.get(index) ?? { id: "", name: "", arguments: "" };
            value.id = call.id ?? value.id;
            value.name = call.function?.name ?? value.name;
            value.arguments += call.function?.arguments ?? "";
            pending.set(index, value);
          }
        }
      }
      yield {
        type: "response_done",
        response: {
          model,
          content: content || null,
          toolCalls: [...pending.values()].map((call) => ({ type: "toolCall" as const, ...call, arguments: JSON.parse(call.arguments || "{}") })),
          usage,
          latencyMs: Math.round(performance.now() - started),
          finishReason: reason,
        },
      };
  }
}
