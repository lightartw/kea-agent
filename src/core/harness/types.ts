import type {
  Context,
  Message,
  ModelConfig,
  ModelRuntime,
  StreamChunk,
  StreamOptions,
} from "../ai/types.js";
import type { Events } from "../events/events.js";
import type { AgentToolRegistry } from "./tools/registry.js";
import type { Session } from "./session/session.js";

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
 * State of one Agent Run, constructed by the caller for each
 * `runAgentLoop()` call. The messages view is read-only from the Agent's
 * perspective; every completed message is committed through
 * `appendMessage()` so the owning Session persists it before the
 * corresponding events are emitted.
 */
export interface AgentContext {
  /** Identifies the Session this Run belongs to, for event listeners. */
  readonly sessionId: string;
  /** Correlates every Turn and Tool Call of this Run. */
  readonly runId: string;
  /** Working directory in which this Session executes Tool Calls. */
  readonly cwd: string;

  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolRegistry;

  /** Shared event dispatcher; control listeners wrap pending behavior via intercept(). */
  readonly events: Events;
  /** Cancellation for the whole Run. */
  readonly signal?: AbortSignal;

  appendMessage(message: AgentMessage): Promise<void>;
}

/**
 * Loop policy for one Agent Run. Execution state lives in `AgentContext`;
 * everything in here only steers the loop itself.
 */
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** Hard upper bound for completed model Turns in this Run. */
  readonly maxTurns?: number;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (
    messages: readonly AgentMessage[],
  ) => readonly Message[];
}

/** Dependencies required to run one Session-bound AgentHarness. */
export interface HarnessConfig {
  readonly session: Session;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
  readonly maxTurns?: number;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: string;
  readonly events: Events;
}
