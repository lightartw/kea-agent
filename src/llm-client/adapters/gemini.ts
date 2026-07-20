import { GoogleGenAI } from "@google/genai";

import {
  mergeOptions,
  type AdapterConfig,
  type LLMClient,
  type LLMOptions,
  type ResolvedLLMOptions,
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
  options: ResolvedLLMOptions,
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

function translateError(error: unknown, timedOut = false): unknown {
  if (timedOut || error instanceof TimeoutError) {
    return new LLMTimeoutError("Gemini request timed out", { cause: error });
  }
  if ([401, 403].includes(authenticationStatus(error) ?? 0)) {
    return new LLMProviderError("Gemini authentication failed", {
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
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    return this.invokeInternal(messages, tools, options);
  }

  private async invokeInternal(
    messages: readonly Message[],
    tools: readonly ToolSchema[] | undefined,
    callOptions: LLMOptions | undefined,
  ): Promise<LLMResponse> {
    const options = mergeOptions(this.config.defaultOptions, callOptions);
    const converted = convertMessages(messages);
    const started = performance.now();
    try {
      const response = await runWithTimeout(options.timeout, (timeoutSignal) =>
        this.client.models.generateContent({
          model: this.config.model,
          contents: converted.contents,
          config: buildConfig(converted.system, tools, options, timeoutSignal),
        }),
      );
      return normalize(
        response,
        this.config.model,
        Math.round(performance.now() - started),
      );
    } catch (error) {
      throw translateError(error);
    }
  }

  async *stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    callOptions?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const options = mergeOptions(this.config.defaultOptions, callOptions);
    const converted = convertMessages(messages);
    const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(options.timeout));
    const request = {
      model: this.config.model,
      contents: converted.contents,
      config: buildConfig(converted.system, tools, options, timeoutSignal),
    };
    const started = performance.now();
    let model = this.config.model;
    let content = "";
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finalReason: FinishReason = null;
    const toolCalls: ToolCall[] = [];
    try {
      const stream = await this.client.models.generateContentStream(request);
      if (
        typeof stream !== "object" ||
        stream === null ||
        !(Symbol.asyncIterator in stream)
      ) {
        throw new LLMProviderError("Gemini returned an invalid stream");
      }
      for await (const chunk of stream as AsyncIterable<unknown>) {
        const normalized = normalize(
          chunk,
          this.config.model,
          Math.round(performance.now() - started),
        );
        model = normalized.model;
        usage = normalized.usage;
        finalReason = normalized.finishReason ?? finalReason;
        toolCalls.push(...normalized.toolCalls);
        if (normalized.content) {
          content += normalized.content;
          yield { type: "text_delta", text: normalized.content };
        }
      }
    } catch (error) {
      throw translateError(error, timeoutSignal.aborted);
    }

    yield {
      type: "response_done",
      response: {
        model,
        content: content || null,
        toolCalls,
        usage,
        latencyMs: Math.round(performance.now() - started),
        finishReason: toolCalls.length > 0 ? "tool_calls" : finalReason,
      },
    };
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
