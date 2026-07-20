import { GoogleGenAI } from "@google/genai";

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

interface GeminiClientLike {
  readonly models: {
    generateContent(request: Record<string, unknown>): Promise<unknown>;
    generateContentStream(request: Record<string, unknown>): Promise<unknown>;
  };
}

interface GeminiClientOptions {
  readonly apiKey: string;
  readonly httpOptions?: { readonly baseUrl: string };
}

type GeminiClientFactory = (options: GeminiClientOptions) => GeminiClientLike;

interface ConvertedMessages {
  readonly system?: string;
  readonly contents: readonly Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertMessages(messages: readonly Message[]): ConvertedMessages {
  const systemParts: string[] = [];
  const contents: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else if (message.role === "assistant" && message.toolCalls !== undefined) {
      const parts: Record<string, unknown>[] = [];
      if (message.content) parts.push({ text: message.content });
      parts.push(
        ...message.toolCalls.map((call) => ({
          functionCall: {
            id: call.id,
            name: call.name,
            args: call.arguments,
          },
        })),
      );
      contents.push({ role: "model", parts });
    } else if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: message.toolCallId,
              name: message.name,
              response: { output: message.content },
            },
          },
        ],
      });
    } else {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      });
    }
  }

  const system = systemParts.join("\n\n");
  return system ? { system, contents } : { contents };
}

function buildConfig(
  system: string | undefined,
  tools: readonly ToolSchema[] | undefined,
  options: ResolvedLLMCallOptions,
  signal: AbortSignal,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    maxOutputTokens: options.maxTokens,
    abortSignal: signal,
  };
  if (system !== undefined) config.systemInstruction = system;
  if (options.temperature !== undefined) config.temperature = options.temperature;
  if (options.topP !== undefined) config.topP = options.topP;
  if (options.stop !== undefined) config.stopSequences = options.stop;
  if (tools !== undefined) {
    config.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: tool.function.parameters,
        })),
      },
    ];
  }
  return config;
}

function finishReason(response: Record<string, unknown>, hasCalls: boolean): FinishReason {
  if (hasCalls) return "tool_calls";
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const first = candidates[0];
  if (!isRecord(first)) return null;
  const rawReason = first.finishReason;
  const normalized = String(rawReason ?? "").split(".").at(-1)?.toUpperCase();
  if (normalized === "STOP") return "stop";
  if (normalized === "MAX_TOKENS") return "length";
  return null;
}

function toolArguments(value: unknown): ToolArguments {
  if (!isRecord(value)) {
    throw new LLMProviderError("Gemini tool arguments must be an object");
  }
  return { ...value };
}

function normalize(
  response: unknown,
  configuredModel: string,
  latencyMs: number,
): LLMResponse {
  if (!isRecord(response)) {
    throw new LLMProviderError("Gemini returned an invalid response");
  }

  const providerCalls = Array.isArray(response.functionCalls)
    ? response.functionCalls
    : [];
  const toolCalls: ToolCall[] = providerCalls.map((rawCall, index) => {
    if (!isRecord(rawCall) || typeof rawCall.name !== "string") {
      throw new LLMProviderError("Gemini returned an invalid tool call");
    }
    return {
      id:
        typeof rawCall.id === "string" && rawCall.id.length > 0
          ? rawCall.id
          : `gemini-call-${index}`,
      name: rawCall.name,
      arguments: toolArguments(rawCall.args ?? {}),
    };
  });

  const usage = isRecord(response.usageMetadata) ? response.usageMetadata : {};
  const inputTokens = Number(usage.promptTokenCount ?? 0) || 0;
  const outputTokens = Number(usage.candidatesTokenCount ?? 0) || 0;
  const totalTokens =
    usage.totalTokenCount === undefined
      ? inputTokens + outputTokens
      : Number(usage.totalTokenCount) || 0;
  return {
    model:
      typeof response.modelVersion === "string" && response.modelVersion
        ? response.modelVersion
        : configuredModel,
    content:
      typeof response.text === "string" && response.text.length > 0
        ? response.text
        : null,
    toolCalls,
    usage: { inputTokens, outputTokens, totalTokens },
    latencyMs,
    finishReason: finishReason(response, toolCalls.length > 0),
  };
}

function authenticationStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  for (const key of ["status", "statusCode", "code"] as const) {
    const value = error[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function translateError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): unknown {
  if (callerSignal?.aborted) return callerSignal.reason;
  if (timeoutSignal.aborted) {
    return new LLMTimeoutError("Gemini request timed out", { cause: error });
  }
  if ([401, 403].includes(authenticationStatus(error) ?? 0)) {
    return new LLMAuthenticationError("Gemini authentication failed", {
      cause: error,
    });
  }
  if (error instanceof LLMError) return error;
  return new LLMProviderError(
    `Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export class GeminiAdapter implements LLMClient {
  constructor(
    private readonly config: AdapterConfig,
    private readonly client: GeminiClientLike,
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
    const converted = convertMessages(messages);
    const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(options.timeout));
    const combined = combineAbortSignals([options.signal, timeoutSignal]);
    const request = {
      model: this.config.model,
      contents: converted.contents,
      config: buildConfig(converted.system, tools, options, combined.signal!),
    };
    const started = performance.now();
    try {
      const response = await raceWithSignal(
        this.client.models.generateContent(request),
        combined.signal!,
      );
      return normalize(
        response,
        this.config.model,
        Math.round(performance.now() - started),
      );
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
    const converted = convertMessages(messages);
    const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(options.timeout));
    const lifecycle = new AbortController();
    const combined = combineAbortSignals([
      options.signal,
      timeoutSignal,
      lifecycle.signal,
    ]);
    const request = {
      model: this.config.model,
      contents: converted.contents,
      config: buildConfig(converted.system, undefined, options, combined.signal!),
    };
    let iterator: AsyncIterator<unknown> | undefined;
    let completed = false;
    try {
      const stream = await raceWithSignal(
        this.client.models.generateContentStream(request),
        combined.signal!,
      );
      if (
        typeof stream !== "object" ||
        stream === null ||
        !(Symbol.asyncIterator in stream)
      ) {
        throw new LLMProviderError("Gemini returned an invalid stream");
      }
      iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      while (true) {
        const item = await raceWithSignal(iterator.next(), combined.signal!);
        if (item.done) {
          completed = true;
          break;
        }
        if (
          isRecord(item.value) &&
          typeof item.value.text === "string" &&
          item.value.text.length > 0
        ) {
          yield item.value.text;
        }
      }
    } catch (error) {
      throw translateError(error, options.signal, timeoutSignal);
    } finally {
      try {
        if (!completed) {
          lifecycle.abort(new Error("Gemini stream closed"));
          closeAsyncIterator(iterator);
        }
      } finally {
        combined.cleanup();
      }
    }
  }
}

export async function createGeminiAdapter(
  config: AdapterConfig,
  clientFactory: GeminiClientFactory = (options) =>
    new GoogleGenAI(options) as unknown as GeminiClientLike,
): Promise<GeminiAdapter> {
  const clientOptions: {
    apiKey: string;
    httpOptions?: { baseUrl: string };
  } = { apiKey: config.apiKey };
  if (config.baseUrl !== null) {
    clientOptions.httpOptions = { baseUrl: config.baseUrl };
  }
  return new GeminiAdapter(config, clientFactory(clientOptions));
}
