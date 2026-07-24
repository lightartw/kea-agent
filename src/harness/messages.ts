import type { Message } from "../ai/types.js";

/**
 * Convert agent-level messages to LLM-consumable messages.
 * Currently a pass-through; extensibility point for custom message types
 * via declaration merging in the future.
 */
export function convertToLlm(messages: readonly Message[]): Message[] {
  return [...messages];
}
