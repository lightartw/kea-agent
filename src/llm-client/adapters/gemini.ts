import { GoogleGenAI } from "@google/genai";

import { mergeOptions } from "../client.js";
import type {
  FinishReason,
  LLMClient,
  LLMConfig,
  LLMOptions,
  LLMResponse,
  LLMStreamEvent,
  Message,
} from "../types.js";
import { runWithTimeout, timeoutMilliseconds } from "../../utils/timeout.js";
import type { ToolCall, ToolSchema } from "../types.js";

// Gemini names assistant messages `model` and puts system text in config.
function messagesForGemini(messages: readonly Message[]) {
  const system: string[] = [];
  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
    } else if (message.role === "assistant" && message.toolCalls) {
      contents.push({
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.arguments } })),
        ],
      });
    } else if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { id: message.toolCallId, name: message.name, response: { output: message.content } } }],
      });
    } else {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] });
    }
  }
  return { ...(system.length ? { system: system.join("\n\n") } : {}), contents };
}

function configForGemini(
  system: string | undefined,
  tools: readonly ToolSchema[] | undefined,
  options: LLMOptions,
  signal: AbortSignal,
): Record<string, unknown> {
  return {
    maxOutputTokens: options.maxTokens,
    abortSignal: signal,
    ...(system === undefined ? {} : { systemInstruction: system }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { topP: options.topP }),
    ...(options.stop === undefined ? {} : { stopSequences: options.stop }),
    ...(tools === undefined ? {} : {
      tools: [{
        functionDeclarations: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: tool.function.parameters,
        })),
      }],
    }),
  };
}

function finishReason(response: any, hasCalls: boolean): FinishReason {
  if (hasCalls) return "tool_calls";
  const reason = String(response.candidates?.[0]?.finishReason ?? "").split(".").at(-1)?.toUpperCase();
  if (reason === "MAX_TOKENS") return "length";
  return reason === "STOP" ? "stop" : null;
}

function callsForGemini(calls: any[] = [], offset = 0): ToolCall[] {
  return calls.map((call, index) => ({
    id: call.id || `gemini-call-${offset + index}`,
    name: call.name,
    arguments: call.args ?? {},
  }));
}

function responseForGemini(response: any, configuredModel: string, latencyMs: number, callOffset = 0): LLMResponse {
  const toolCalls = callsForGemini(response.functionCalls, callOffset);
  const usage = response.usageMetadata ?? {};
  const inputTokens = Number(usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.candidatesTokenCount ?? 0);
  return {
    model: response.modelVersion || configuredModel,
    content: response.text || null,
    toolCalls,
    usage: { inputTokens, outputTokens, totalTokens: Number(usage.totalTokenCount ?? inputTokens + outputTokens) },
    latencyMs,
    finishReason: finishReason(response, toolCalls.length > 0),
  };
}

/** Gemini implementation of the common LLMClient interface. */
export class GeminiAdapter implements LLMClient {
  private readonly sdk: GoogleGenAI;

  constructor(private readonly config: LLMConfig) {
    this.sdk = new GoogleGenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === null ? {} : { httpOptions: { baseUrl: config.baseUrl } }),
    });
  }

  async invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    overrides?: Partial<LLMOptions>,
  ): Promise<LLMResponse> {
      const options = mergeOptions(this.config.options, overrides);
      const converted = messagesForGemini(messages);
      const started = performance.now();
      const response = await runWithTimeout(options.timeout, (signal) =>
        this.sdk.models.generateContent({
          model: this.config.model,
          contents: converted.contents as any,
          config: configForGemini(converted.system, tools, options, signal) as any,
        }),
      );
      return responseForGemini(response, this.config.model, Math.round(performance.now() - started));
  }

  async *stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    overrides?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent> {
      const options = mergeOptions(this.config.options, overrides);
      const converted = messagesForGemini(messages);
      const stream = await this.sdk.models.generateContentStream({
        model: this.config.model,
        contents: converted.contents as any,
        config: configForGemini(
          converted.system,
          tools,
          options,
          AbortSignal.timeout(timeoutMilliseconds(options.timeout)),
        ) as any,
      });

      const started = performance.now();
      let model = this.config.model;
      let content = "";
      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let reason: FinishReason = null;
      const toolCalls: ToolCall[] = [];
      for await (const chunk of stream as any) {
        const response = responseForGemini(chunk, this.config.model, 0, toolCalls.length);
        model = response.model || model;
        if (chunk.usageMetadata) usage = response.usage;
        reason = response.finishReason ?? reason;
        toolCalls.push(...response.toolCalls);
        if (response.content) {
          content += response.content;
          yield { type: "text_delta", text: response.content };
        }
      }
      yield {
        type: "response_done",
        response: {
          model,
          content: content || null,
          toolCalls,
          usage,
          latencyMs: Math.round(performance.now() - started),
          finishReason: toolCalls.length ? "tool_calls" : reason,
        },
      };
  }
}
