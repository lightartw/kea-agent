import type { Message, ModelConfig } from "../ai/types.js";
import type { Events } from "../events/events.js";
import type { AgentRunIdentity } from "./events.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";

/**
 * Agent-layer message type. Currently an alias for Message; will become
 * an extensible union when custom message types are needed.
 */
export type AgentMessage = Message;

/**
 * Snapshot of agent state passed into the loop.
 * The loop mutates context.messages in place.
 */
export interface AgentContext {
  readonly systemPrompt: string;
  messages: AgentMessage[];
  readonly tools: AgentToolRegistry;
}

/**
 * Configuration consumed by the agent loop.
 * Control flows through the shared `Events` dispatcher using ask()/transform();
 * the loop never calls hooks directly.
 */
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  /** Shared event dispatcher; control listeners answer via ask()/transform(). */
  readonly events: Events;
  /** Identity of the current run, attached to every control event. */
  readonly run: AgentRunIdentity;
}

/**
 * Presentation-neutral events emitted during one agent run.
 * CLI and future TUI render these independently.
 * All message/tool-call types are agent-layer, not ai-layer.
 */
export type ToolRejectedReason = "blocked" | "invalid" | "unknown" | "aborted";

export interface ToolRejectedEvent {
  readonly type: "tool_rejected";
  /** The model's original request; arguments are never rewritten by listeners. */
  readonly call: AgentToolCall;
  /** Listener-processed arguments, when a working copy was formed before rejection. */
  readonly effectiveArguments?: Readonly<Record<string, unknown>>;
  readonly result: AgentToolResult;
  readonly reason: ToolRejectedReason;
}

export type AgentEvent =
  // Run lifecycle
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end";   readonly messages: readonly AgentMessage[] }
  // Turn lifecycle
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end";    readonly message: AgentMessage }
  // Streaming content
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: AgentToolCall }
  // Tool execution
  | { readonly type: "tool_start";      readonly call: AgentToolCall }
  | { readonly type: "tool_end";        readonly call: AgentToolCall; readonly result: AgentToolResult }
  | ToolRejectedEvent;
