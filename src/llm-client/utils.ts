import { LLMProviderError } from "./errors.js";
import type { ToolArguments } from "./models.js";

/**
 * Shared checks at the provider boundary. SDK responses are external data, but
 * every ToolRegistry call requires one plain object as its arguments.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolArguments(provider: string, value: unknown): ToolArguments {
  if (!isRecord(value)) {
    throw new LLMProviderError(`${provider} tool arguments must be an object`);
  }
  return { ...value };
}

export function parseToolArguments(
  provider: string,
  value: unknown,
): ToolArguments {
  if (typeof value !== "string") {
    throw new LLMProviderError(`${provider} tool arguments must be JSON text`);
  }
  try {
    return toolArguments(provider, JSON.parse(value || "{}"));
  } catch (error) {
    if (error instanceof LLMProviderError) throw error;
    throw new LLMProviderError(`${provider} tool arguments contain invalid JSON`, {
      cause: error,
    });
  }
}
