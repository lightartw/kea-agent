import Anthropic, {
  APIConnectionTimeoutError,
  AuthenticationError,
} from "@anthropic-ai/sdk";

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

interface AnthropicClientLike {
  readonly messages: {
    create(
      request: Record<string, unknown>,
      options: { readonly timeout: number; readonly signal: AbortSignal },
    ): Promise<unknown>;
  };
}

interface ConvertedMessages {
  readonly system?: string;
  readonly messages: readonly Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertMessages(messages: readonly Message[]): ConvertedMessages {
  const systemParts: string[] = [];
  const converted: Record<string, unknown>[] = [];
  const pendingToolResults: Record<string, unknown>[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      converted.push({ role: "user", content: [...pendingToolResults] });
      pendingToolResults.length = 0;
    }
  };

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }

    flushToolResults();
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      const content: Record<string, unknown>[] = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      content.push(
        ...message.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      );
      converted.push({ role: "assistant", content });
    } else {
      converted.push({ role: message.role, content: message.content });
    }
  }

  flushToolResults();
  const system = systemParts.join("\n\n");
  return system
    ? { system, messages: converted }
    : { messages: converted };
}

function convertTools(tools: readonly ToolSchema[]): readonly Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function requestOptions(
  options: ResolvedLLMOptions,
): Record<string, unknown> {
  const request: Record<string, unknown> = { max_tokens: options.maxTokens };
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.topP !== undefined) request.top_p = options.topP;
  if (options.stop !== undefined) request.stop_sequences = options.stop;
  return request;
}

function finishReason(reason: unknown): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return null;
  }
}

function toolArguments(value: unknown): ToolArguments {
  if (!isRecord(value)) {
    throw new LLMProviderError("Anthropic tool arguments must be an object");
  }
  return { ...value };
}

function normalize(response: unknown, latencyMs: number): LLMResponse {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    throw new LLMProviderError("Anthropic returned an invalid response");
  }

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of response.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: toolArguments(block.input),
      });
    }
  }

  const usage = isRecord(response.usage) ? response.usage : {};
  const inputTokens = Number(usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? 0) || 0;
  return {
    model: typeof response.model === "string" ? response.model : "",
    content: text || null,
    toolCalls,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    latencyMs,
    finishReason: finishReason(response.stop_reason),
  };
}

function translateError(error: unknown, timedOut = false): unknown {
  if (
    timedOut ||
    error instanceof TimeoutError ||
    error instanceof APIConnectionTimeoutError
  ) {
    return new LLMTimeoutError("Anthropic request timed out", { cause: error });
  }
  if (error instanceof AuthenticationError) {
    return new LLMProviderError("Anthropic authentication failed", {
      cause: error,
    });
  }
  if (error instanceof LLMError) return error;
  return new LLMProviderError(
    `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export class AnthropicAdapter implements LLMClient {
  constructor(
    private readonly config: AdapterConfig,
    private readonly client: AnthropicClientLike,
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
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages: converted.messages,
      ...requestOptions(options),
    };
    if (converted.system !== undefined) request.system = converted.system;
    if (tools !== undefined) request.tools = convertTools(tools);

    const timeoutMs = timeoutMilliseconds(options.timeout);
    const started = performance.now();
    try {
      const response = await runWithTimeout(options.timeout, (timeoutSignal) =>
        this.client.messages.create(request, {
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
    callOptions?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const options = mergeOptions(this.config.defaultOptions, callOptions);
    const converted = convertMessages(messages);
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages: converted.messages,
      stream: true,
      ...requestOptions(options),
    };
    if (converted.system !== undefined) request.system = converted.system;
    if (tools !== undefined) request.tools = convertTools(tools);

    const timeoutMs = timeoutMilliseconds(options.timeout);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const started = performance.now();
    let model = this.config.model;
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finalReason: FinishReason = null;
    const pendingCalls = new Map<
      number,
      { id: string; name: string; argumentsText: string }
    >();
    try {
      const stream = await this.client.messages.create(request, {
          timeout: timeoutMs,
          signal: timeoutSignal,
        });
      if (
        typeof stream !== "object" ||
        stream === null ||
        !(Symbol.asyncIterator in stream)
      ) {
        throw new LLMProviderError("Anthropic returned an invalid stream");
      }
      for await (const event of stream as AsyncIterable<unknown>) {
        if (!isRecord(event)) continue;
        if (event.type === "message_start" && isRecord(event.message)) {
          if (typeof event.message.model === "string") model = event.message.model;
          if (isRecord(event.message.usage)) {
            inputTokens = Number(event.message.usage.input_tokens ?? 0) || 0;
            outputTokens = Number(event.message.usage.output_tokens ?? 0) || 0;
          }
        } else if (
          event.type === "content_block_start" &&
          Number.isInteger(event.index) &&
          isRecord(event.content_block) &&
          event.content_block.type === "tool_use" &&
          typeof event.content_block.id === "string" &&
          typeof event.content_block.name === "string"
        ) {
          const input = event.content_block.input;
          const argumentsText =
            isRecord(input) && Object.keys(input).length > 0
              ? JSON.stringify(input)
              : "";
          pendingCalls.set(Number(event.index), {
            id: event.content_block.id,
            name: event.content_block.name,
            argumentsText,
          });
        } else if (
          event.type === "content_block_delta" &&
          Number.isInteger(event.index) &&
          isRecord(event.delta)
        ) {
          if (
            event.delta.type === "text_delta" &&
            typeof event.delta.text === "string" &&
            event.delta.text
          ) {
            content += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          } else if (
            event.delta.type === "input_json_delta" &&
            typeof event.delta.partial_json === "string"
          ) {
            const pending = pendingCalls.get(Number(event.index));
            if (pending !== undefined) {
              pending.argumentsText += event.delta.partial_json;
            }
          }
        } else if (event.type === "message_delta") {
          if (isRecord(event.delta)) {
            finalReason = finishReason(event.delta.stop_reason) ?? finalReason;
          }
          if (isRecord(event.usage)) {
            outputTokens = Number(event.usage.output_tokens ?? outputTokens) || 0;
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
        arguments: toolArguments(JSON.parse(call.argumentsText || "{}")),
      }));
    yield {
      type: "response_done",
      response: {
        model,
        content: content || null,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        latencyMs: Math.round(performance.now() - started),
        finishReason: finalReason,
      },
    };
  }

}

export async function createAnthropicAdapter(
  config: AdapterConfig,
): Promise<AnthropicAdapter> {
  const clientOptions: { apiKey: string; baseURL?: string } = {
    apiKey: config.apiKey,
  };
  if (config.baseUrl !== null) clientOptions.baseURL = config.baseUrl;
  const client = new Anthropic(clientOptions);
  return new AnthropicAdapter(config, client as unknown as AnthropicClientLike);
}
