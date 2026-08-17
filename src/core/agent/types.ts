import type {
  Context,
  Message,
  ModelConfig,
  StreamChunk,
  StreamOptions,
} from "../ai/types.js";
import type { Events } from "../events/events.js";
import type { AgentToolRegistry } from "./tools/registry.js";

/**
 * Identity of one Agent Run. One Project-level `Events` instance is shared by
 * multiple Sessions, so listeners need `sessionId` to filter; `runId`
 * correlates events across the concurrent Runs of a shared dispatcher.
 */
export interface AgentRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
}

/**
 * Agent-layer message type. Currently an alias for Message; will become
 * an extensible union when custom message types are needed.
 */
export type AgentMessage = Message;

/** Minimal model execution capability required by the Agent Loop. */
export type StreamFn = (
  modelConfig: ModelConfig,
  context: Context,
  options?: Partial<StreamOptions>,
) => AsyncIterable<StreamChunk>;

/**
 * Agent state passed into the loop. The messages view is read-only from
 * the Agent's perspective; every completed message is committed through
 * `appendMessage()` so the owning Session persists it before the corresponding
 * events are emitted.
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
  /** Hard upper bound for completed model Turns in this Run. */
  readonly maxTurns?: number;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
  /** Shared event dispatcher; control listeners wrap pending behavior via intercept(). */
  readonly events: Events;
  /** Identity of the current run, attached to every event. */
  readonly run: AgentRunIdentity;
}
