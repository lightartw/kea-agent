import OpenAI, {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "openai";

import {
  mergeOptions,
  type LLMClient,
  type LLMConfig,
  type LLMOptions,
} from "../client.js";
import {
  LLMError,
  LLMProviderError,
  LLMTimeoutError,
} from "../errors.js";
import type {
  FinishReason,
  LLMResponse,
  LLMStreamEvent,
  Message,
  ToolArguments,
  ToolCall,
  ToolSchema,
} from "../models.js";
import {
  TimeoutError,
  runWithTimeout,
  timeoutMilliseconds,
} from "../../utils/timeout.js";

interface OpenAIClientLike {
  readonly chat: {
    readonly completions: {
      create(
        request: Record<string, unknown>,
        options: { readonly timeout: number; readonly signal: AbortSignal },
      ): Promise<unknown>;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertMessages(
  messages: readonly Message[],
): readonly Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    return { role: message.role, content: message.content };
  });
}

function requestOptions(
  options: LLMOptions,
): Record<string, unknown> {
  const request: Record<string, unknown> = { max_tokens: options.maxTokens };
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.topP !== undefined) request.top_p = options.topP;
  if (options.stop !== undefined) request.stop = options.stop;
  return request;
}

function finishReason(reason: unknown): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return null;
  }
}

function parseToolArguments(value: unknown): ToolArguments {
  if (typeof value !== "string") {
    throw new LLMProviderError("OpenAI tool arguments must be JSON text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch (error) {
    throw new LLMProviderError("OpenAI tool arguments contain invalid JSON", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new LLMProviderError("OpenAI tool arguments must be an object");
  }
  return parsed;
}

function normalize(response: unknown, latencyMs: number): LLMResponse {
  if (!isRecord(response) || !Array.isArray(response.choices)) {
    throw new LLMProviderError("OpenAI returned an invalid response");
  }
  const choice = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new LLMProviderError("OpenAI returned no completion choice");
  }

  const providerCalls = Array.isArray(choice.message.tool_calls)
    ? choice.message.tool_calls
    : [];
  const toolCalls: ToolCall[] = providerCalls.map((rawCall) => {
    if (
      !isRecord(rawCall) ||
      typeof rawCall.id !== "string" ||
      !isRecord(rawCall.function) ||
      typeof rawCall.function.name !== "string"
    ) {
      throw new LLMProviderError("OpenAI returned an invalid tool call");
    }
    return {
      id: rawCall.id,
      name: rawCall.function.name,
      arguments: parseToolArguments(rawCall.function.arguments),
    };
  });

  const usage = isRecord(response.usage) ? response.usage : {};
  const inputTokens = Number(usage.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? 0) || 0;
  const totalTokens =
    usage.total_tokens === undefined
      ? inputTokens + outputTokens
      : Number(usage.total_tokens) || 0;
  return {
    model: typeof response.model === "string" ? response.model : "",
    content:
      typeof choice.message.content === "string"
        ? choice.message.content || null
        : null,
    toolCalls,
    usage: { inputTokens, outputTokens, totalTokens },
    latencyMs,
    finishReason: finishReason(choice.finish_reason),
  };
}

function translateError(error: unknown, timedOut = false): unknown {
  if (
    timedOut ||
    error instanceof TimeoutError ||
    error instanceof APIConnectionTimeoutError
  ) {
    return new LLMTimeoutError("OpenAI request timed out", { cause: error });
  }
  if (error instanceof AuthenticationError) {
    return new LLMProviderError("OpenAI authentication failed", {
      cause: error,
    });
  }
  if (error instanceof LLMError) return error;
  return new LLMProviderError(
    `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export class OpenAIAdapter implements LLMClient {
  constructor(
    private readonly config: LLMConfig,
    private readonly client: OpenAIClientLike,
  ) {}

  invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse> {
    return this.invokeInternal(messages, tools, options);
  }

  private async invokeInternal(
    messages: readonly Message[],
    tools: readonly ToolSchema[] | undefined,
    callOptions: Partial<LLMOptions> | undefined,
  ): Promise<LLMResponse> {
    const options = mergeOptions(this.config.options, callOptions);
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages: convertMessages(messages),
      ...requestOptions(options),
    };
    if (tools !== undefined) request.tools = tools;

    const timeoutMs = timeoutMilliseconds(options.timeout);
    const started = performance.now();
    try {
      const response = await runWithTimeout(options.timeout, (timeoutSignal) =>
        this.client.chat.completions.create(request, {
          timeout: timeoutMs,
          signal: timeoutSignal,
        }),
      );
      return normalize(response, Math.round(performance.now() - started));
    } catch (error) {
      throw translateError(error);
    }
  }

  async *stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    callOptions?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent> {
    const options = mergeOptions(this.config.options, callOptions);
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages: convertMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      ...requestOptions(options),
    };
    if (tools !== undefined) request.tools = tools;

    const timeoutMs = timeoutMilliseconds(options.timeout);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const started = performance.now();
    let model = this.config.model;
    let content = "";
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finalReason: FinishReason = null;
    const pendingCalls = new Map<
      number,
      { id: string; name: string; argumentsText: string }
    >();
    try {
      const stream = await this.client.chat.completions.create(request, {
        timeout: timeoutMs,
        signal: timeoutSignal,
      });
      if (
        typeof stream !== "object" ||
        stream === null ||
        !(Symbol.asyncIterator in stream)
      ) {
        throw new LLMProviderError("OpenAI returned an invalid stream");
      }
      for await (const chunk of stream as AsyncIterable<unknown>) {
        if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
        if (typeof chunk.model === "string") model = chunk.model;
        if (isRecord(chunk.usage)) {
          const inputTokens = Number(chunk.usage.prompt_tokens ?? 0) || 0;
          const outputTokens = Number(chunk.usage.completion_tokens ?? 0) || 0;
          usage = {
            inputTokens,
            outputTokens,
            totalTokens:
              Number(chunk.usage.total_tokens ?? inputTokens + outputTokens) || 0,
          };
        }
        for (const choice of chunk.choices) {
          if (!isRecord(choice) || !isRecord(choice.delta)) continue;
          finalReason = finishReason(choice.finish_reason) ?? finalReason;
          if (typeof choice.delta.content === "string" && choice.delta.content) {
            content += choice.delta.content;
            yield { type: "text_delta", text: choice.delta.content };
          }
          if (Array.isArray(choice.delta.tool_calls)) {
            for (const [position, rawCall] of choice.delta.tool_calls.entries()) {
              if (!isRecord(rawCall)) continue;
              const index = Number.isInteger(rawCall.index)
                ? Number(rawCall.index)
                : position;
              const pending = pendingCalls.get(index) ?? {
                id: "",
                name: "",
                argumentsText: "",
              };
              if (typeof rawCall.id === "string") pending.id = rawCall.id;
              if (isRecord(rawCall.function)) {
                if (typeof rawCall.function.name === "string") {
                  pending.name = rawCall.function.name;
                }
                if (typeof rawCall.function.arguments === "string") {
                  pending.argumentsText += rawCall.function.arguments;
                }
              }
              pendingCalls.set(index, pending);
            }
          }
        }
      }
    } catch (error) {
      throw translateError(error, timeoutSignal.aborted);
    }

    const toolCalls = [...pendingCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: parseToolArguments(call.argumentsText),
      }));
    yield {
      type: "response_done",
      response: {
        model,
        content: content || null,
        toolCalls,
        usage,
        latencyMs: Math.round(performance.now() - started),
        finishReason: finalReason,
      },
    };
  }
}

export async function createOpenAIAdapter(
  config: LLMConfig,
): Promise<OpenAIAdapter> {
  const clientOptions: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseUrl !== null) clientOptions.baseURL = config.baseUrl;
  const client = new OpenAI(clientOptions);
  return new OpenAIAdapter(config, client as unknown as OpenAIClientLike);
}
