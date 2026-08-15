import { GoogleGenAI } from "@google/genai";

import type { Adapter, ResolvedOptions } from "../factory.js";
import type {
  ContentBlock,
  Context,
  Message,
  StopReason,
  StreamChunk,
  TextBlock,
  Tool,
  ToolCall,
} from "../types.js";
import { errorMessage, mergeSignals } from "../../util/index.js";

// ── Message conversion ──

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
      contents.push({ role: "user", parts: [{ text: message.content }] });
    }
  }
  return { contents };
}

// ── Conversion helpers ──

function configForGemini(
  system: string | undefined,
  tools: readonly Tool[] | undefined,
  options: ResolvedOptions,
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

export class GeminiAdapter implements Adapter {
  private readonly sdk: GoogleGenAI;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.sdk = new GoogleGenAI({
      apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });
  }

  async *stream(
    model: string,
    context: Context,
    options: ResolvedOptions,
  ): AsyncIterable<StreamChunk> {
    const converted = messagesForGemini(context.messages);

    const started = performance.now();
    let usedModel = model;
    let content = "";
    let stopReason: StopReason = "stop";
    let allCalls: ToolCall[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      const sdkStream = await this.sdk.models.generateContentStream({
        model,
        contents: converted.contents as any,
        config: configForGemini(
          context.systemPrompt,
          context.tools,
          options,
          mergeSignals(options.timeout, options.signal),
        ) as any,
      });

      for await (const chunk of sdkStream as any) {
        if (chunk.modelVersion) usedModel = chunk.modelVersion;

        if (chunk.usageMetadata) usage = extractUsage(chunk);

        if (chunk.text) {
          content += chunk.text;
          yield { type: "text_delta", text: chunk.text };
        }

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

        const reason = mapStopReason(chunk, functionCalls.length > 0);
        if (reason !== "stop" || chunk.candidates?.[0]?.finishReason) {
          stopReason = reason;
        }
      }

      const contentBlocks: ContentBlock[] = [];
      if (content.length > 0) {
        contentBlocks.push({ type: "text", text: content } as TextBlock);
      }
      contentBlocks.push(...allCalls);

      yield {
        type: "done",
        message: {
          role: "assistant",
          content: contentBlocks,
          model: usedModel,
          usage,
          stopReason,
          latencyMs: Math.round(performance.now() - started),
        },
      };
    } catch (err: unknown) {
      yield {
        type: "error",
        message: {
          role: "assistant",
          content: [],
          model: usedModel,
          stopReason: "error",
          errorMessage: errorMessage(err),
          latencyMs: Math.round(performance.now() - started),
        },
      };
    }
  }
}
