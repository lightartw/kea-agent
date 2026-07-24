import { GoogleGenAI } from "@google/genai";

import type {
  AssistantMessageEvent,
  ContentBlock,
  Context,
  LLMClient,
  LLMConfig,
  LLMOptions,
  Message,
  StopReason,
  TextBlock,
  Tool,
  ToolCall,
} from "../types.js";
import { timeoutMilliseconds } from "../../utils/timeout.js";

// ── Message conversion ──

/** Convert internal Message[] to Gemini's format.
 *  v2: AssistantMessage.content is ContentBlock[] — map each block to its Gemini equivalent.
 *  Gemini names assistant messages `model` and puts system text in config. */
function messagesForGemini(messages: readonly Message[]) {
  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "toolCall") {
          parts.push({ functionCall: { id: block.id, name: block.name, args: block.arguments } });
        }
        // thinking blocks are not re-sent
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { id: message.toolCallId, name: message.name, response: { output: message.content } } }],
      });
    } else {
      // Must be UserMessage — role is already narrowed to "user"
      contents.push({ role: "user", parts: [{ text: message.content }] });
    }
  }
  return { contents };
}

// ── Conversion helpers ──

function configForGemini(
  system: string | undefined,
  tools: readonly Tool[] | undefined,
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
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      }],
    }),
  };
}

function mapStopReason(response: any, hasCalls: boolean): StopReason {
  if (hasCalls) return "toolUse";
  const reason = String(response.candidates?.[0]?.finishReason ?? "").split(".").at(-1)?.toUpperCase();
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP") return "stop";
  return "error";
}

function extractUsage(response: any) {
  const usage = response.usageMetadata ?? {};
  const inputTokens = Number(usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.candidatesTokenCount ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.totalTokenCount ?? inputTokens + outputTokens),
  };
}

// ── Adapter ──

/** Gemini implementation of the v2 stream-only LLMClient interface. */
export class GeminiAdapter implements LLMClient {
  private readonly sdk: GoogleGenAI;

  constructor(private readonly config: LLMConfig) {
    this.sdk = new GoogleGenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === null ? {} : { httpOptions: { baseUrl: config.baseUrl } }),
    });
  }

  async *stream(
    context: Context,
    options?: Partial<LLMOptions>,
  ): AsyncIterable<AssistantMessageEvent> {
    const opts: LLMOptions = { ...this.config.options, ...options };
    const converted = messagesForGemini(context.messages);

    const started = performance.now();
    let model = this.config.model;
    let content = "";
    let stopReason: StopReason = "stop";
    let allCalls: ToolCall[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      const sdkStream = await this.sdk.models.generateContentStream({
        model: this.config.model,
        contents: converted.contents as any,
        config: configForGemini(
          context.systemPrompt,
          context.tools,
          opts,
          AbortSignal.timeout(timeoutMilliseconds(opts.timeout)),
        ) as any,
      });

      for await (const chunk of sdkStream as any) {
        // Model version
        if (chunk.modelVersion) model = chunk.modelVersion;

        // Usage
        if (chunk.usageMetadata) {
          usage = extractUsage(chunk);
        }

        // Text content (incremental in streaming)
        if (chunk.text) {
          content += chunk.text;
          yield { type: "text_delta", text: chunk.text };
        }

        // Tool calls — Gemini sends complete function calls per chunk
        const functionCalls = chunk.functionCalls ?? [];
        for (const [i, call] of functionCalls.entries()) {
          const id = call.id || `gemini-call-${allCalls.length + i}`;
          const name = call.name;
          const args = call.args ?? {};

          yield { type: "toolcall_start", id, name };
          if (Object.keys(args).length > 0) {
            yield { type: "toolcall_delta", id, argumentsDelta: JSON.stringify(args) };
          }
          const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
          yield { type: "toolcall_end", toolCall };
          allCalls.push(toolCall);
        }

        // Stop reason
        const reason = mapStopReason(chunk, functionCalls.length > 0);
        if (reason !== "stop" || chunk.candidates?.[0]?.finishReason) {
          stopReason = reason;
        }
      }

      // Build ContentBlock[] from accumulated state
      const contentBlocks: ContentBlock[] = [];
      if (content.length > 0) {
        contentBlocks.push({ type: "text", text: content } as TextBlock);
      }
      contentBlocks.push(...allCalls);

      const latencyMs = Math.round(performance.now() - started);
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: contentBlocks,
          model,
          usage,
          stopReason,
          latencyMs,
        },
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        message: {
          role: "assistant",
          content: [],
          model,
          stopReason: "error",
          errorMessage: message,
          latencyMs,
        },
      };
    }
  }
}
