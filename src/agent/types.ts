import type { Message, ModelConfig } from "../ai/types.js";
import type { Events } from "../events/events.js";
import type { AgentRunIdentity } from "./events.js";
import type { AgentToolRegistry } from "./tools/registry.js";

/**
 * Agent-layer message type. Currently an alias for Message; will become
 * an extensible union when custom message types are needed.
 */
export type AgentMessage = Message;

/**
 * Agent state passed into the loop. The messages view is read-only from
 * the Agent's perspective; every completed message is committed through
 * `appendMessage()` so the owning Session persists it before any fact is
 * published.
 */
export interface AgentContext {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolRegistry;
  appendMessage(message: AgentMessage): Promise<void>;
}

/**
 * Configuration consumed by the agent loop.
 * Control flows through the shared `Events` dispatcher using emit()/intercept();
 * the loop never calls hooks directly.
 */
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
  /** Shared event dispatcher; control listeners wrap pending behavior via intercept(). */
  readonly events: Events;
  /** Identity of the current run, attached to every event. */
  readonly run: AgentRunIdentity;
}
