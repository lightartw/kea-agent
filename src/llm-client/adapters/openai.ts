import OpenAI, {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "openai";

import {
  mergeOptions,
  validateMessages,
  validateTools,
  type AdapterConfig,
  type LLMCallOptions,
  type LLMClient,
  type ResolvedLLMCallOptions,
} from "../client.js";
import {
  LLMAuthenticationError,
  LLMError,
  LLMProviderError,
  LLMTimeoutError,
} from "../errors.js";
import type {
  FinishReason,
  LLMResponse,
  Message,
  ToolArguments,
  ToolCall,
  ToolSchema,
} from "../models.js";
import {
  combineAbortSignals,
  closeAsyncIterator,
  raceWithSignal,
  timeoutMilliseconds,
} from "../../utils/abort-signals.js";

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
  options: ResolvedLLMCallOptions,
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
  const parsed: unknown = JSON.parse(value || "{}");
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

function translateError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): unknown {
  if (callerSignal?.aborted) return callerSignal.reason;
  if (timeoutSignal.aborted || error instanceof APIConnectionTimeoutError) {
    return new LLMTimeoutError("OpenAI request timed out", { cause: error });
  }
  if (error instanceof AuthenticationError) {
    return new LLMAuthenticationError("OpenAI authentication failed", {
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
    private readonly config: AdapterConfig,
    private readonly client: OpenAIClientLike,
  ) {}

  invoke(
    messages: readonly Message[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return this.invokeInternal(messages, undefined, options);
  }

  invokeWithTools(
    messages: readonly Message[],
    tools: readonly ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return this.invokeInternal(messages, tools, options);
  }

  private async invokeInternal(
    messages: readonly Message[],
    tools: readonly ToolSchema[] | undefined,
    callOptions: LLMCallOptions | undefined,
  ): Promise<LLMResponse> {
    validateMessages(messages);
    if (tools !== undefined) validateTools(tools);
    const options = mergeOptions(this.config.defaultOptions, callOptions);
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages: convertMessages(messages),
      ...requestOptions(options),
    };
    if (tools !== undefined) request.tools = tools;

    const timeoutMs = timeoutMilliseconds(options.timeout);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = combineAbortSignals([options.signal, timeoutSignal]);
    const started = performance.now();
    try {
      const response = await raceWithSignal(
        this.client.chat.completions.create(request, {
          timeout: timeoutMs,
          signal: combined.signal!,
        }),
        combined.signal!,
      );
      return normalize(response, Math.round(performance.now() - started));
    } catch (error) {
      throw translateError(error, options.signal, timeoutSignal);
    } finally {
      combined.cleanup();
    }
  }

  async *streamInvoke(
    messages: readonly Message[],
    callOptions?: LLMCallOptions,
  ): AsyncIterable<string> {
    validateMessages(messages);
    const options = mergeOptions(this.config.defaultOptions, callOptions);
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages: convertMessages(messages),
      stream: true,
      ...requestOptions(options),
    };

    const timeoutMs = timeoutMilliseconds(options.timeout);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const lifecycle = new AbortController();
    const combined = combineAbortSignals([
      options.signal,
      timeoutSignal,
      lifecycle.signal,
    ]);
    let iterator: AsyncIterator<unknown> | undefined;
    let completed = false;
    try {
      const stream = await raceWithSignal(
        this.client.chat.completions.create(request, {
          timeout: timeoutMs,
          signal: combined.signal!,
        }),
        combined.signal!,
      );
      if (
        typeof stream !== "object" ||
        stream === null ||
        !(Symbol.asyncIterator in stream)
      ) {
        throw new LLMProviderError("OpenAI returned an invalid stream");
      }
      iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      while (true) {
        const item = await raceWithSignal(iterator.next(), combined.signal!);
        if (item.done) {
          completed = true;
          break;
        }
        const chunk = item.value;
        if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
        for (const choice of chunk.choices) {
          if (
            isRecord(choice) &&
            isRecord(choice.delta) &&
            typeof choice.delta.content === "string" &&
            choice.delta.content.length > 0
          ) {
            yield choice.delta.content;
          }
        }
      }
    } catch (error) {
      throw translateError(error, options.signal, timeoutSignal);
    } finally {
      try {
        if (!completed) {
          lifecycle.abort(new Error("OpenAI stream closed"));
          closeAsyncIterator(iterator);
        }
      } finally {
        combined.cleanup();
      }
    }
  }
}

export async function createOpenAIAdapter(
  config: AdapterConfig,
): Promise<OpenAIAdapter> {
  const clientOptions: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseUrl !== null) clientOptions.baseURL = config.baseUrl;
  const client = new OpenAI(clientOptions);
  return new OpenAIAdapter(config, client as unknown as OpenAIClientLike);
}
