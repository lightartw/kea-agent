import { GoogleGenAI } from "@google/genai";

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

/**
 * Gemini boundary. Gemini calls assistant messages `model`, stores system
 * text in config, and represents tools as function declarations. This file
 * keeps those names out of the rest of the agent.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  // Provider data is external. Guard the object reads that feed tool execution.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertMessages(messages: readonly Message[]) {
  // Split system text from conversation contents because Gemini accepts them
  // in different request fields. The return value is request data, not another
  // application Message type.
  const systemParts: string[] = [];
  const contents: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content ?? "");
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
  options: LLMOptions,
  signal: AbortSignal,
): Record<string, unknown> {
  // Provider-specific option and tool spelling belongs in one request fragment.
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
  // Tool calls are the actionable terminal state for agent-turn.
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
  // ToolRegistry expects an object, never a scalar or array.
  if (!isRecord(value)) {
    throw new LLMProviderError("Gemini tool arguments must be an object");
  }
  return { ...value };
}

function normalize(
  response: unknown,
  configuredModel: string,
  latencyMs: number,
  fallbackCallIndex = 0,
): LLMResponse {
  // Convert Gemini's response once, then keep agent-turn provider-agnostic.
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
          : `gemini-call-${fallbackCallIndex + index}`,
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
  // Gemini does not expose one stable authentication error class.
  if (!isRecord(error)) return undefined;
  for (const key of ["status", "statusCode", "code"] as const) {
    const value = error[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function translateError(error: unknown, timedOut = false): unknown {
  // Map SDK-specific errors into the errors the public client exposes.
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
    private readonly config: LLMConfig,
    private readonly client: GeminiClientLike,
  ) {}

  async invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse> {
    const mergedOptions = mergeOptions(this.config.options, options);
    const converted = convertMessages(messages);
    const started = performance.now();
    try {
      const response = await runWithTimeout(mergedOptions.timeout, (timeoutSignal) =>
        this.client.models.generateContent({
          model: this.config.model,
          contents: converted.contents,
          config: buildConfig(converted.system, tools, mergedOptions, timeoutSignal),
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
    callOptions?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent> {
    // Gemini chunks contain complete function calls, but text and metadata can
    // arrive in different chunks, so retain them until response_done.
    const options = mergeOptions(this.config.options, callOptions);
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
          toolCalls.length,
        );
        if (isRecord(chunk)) {
          if (typeof chunk.modelVersion === "string" && chunk.modelVersion) {
            model = chunk.modelVersion;
          }
          if (isRecord(chunk.usageMetadata)) usage = normalized.usage;
        }
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
  config: LLMConfig,
  clientFactory: GeminiClientFactory = (options) =>
    new GoogleGenAI(options) as unknown as GeminiClientLike,
): Promise<GeminiAdapter> {
  // The injectable factory keeps SDK construction out of tests.
  const clientOptions: {
    apiKey: string;
    httpOptions?: { baseUrl: string };
  } = { apiKey: config.apiKey };
  if (config.baseUrl !== null) {
    clientOptions.httpOptions = { baseUrl: config.baseUrl };
  }
  return new GeminiAdapter(config, clientFactory(clientOptions));
}
