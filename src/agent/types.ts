import type { Message, ModelConfig } from "../ai/types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";
import type { HookRegistry } from "./hooks/registry.js";

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
 * Hooks replace the old per-event callbacks — the loop only calls
 * `hooks.trigger()` and delegates reducer semantics to the registry.
 */
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  /** Unified hook registry for tool_call, context, turn_end, user_prompt, pre_turn. */
  readonly hooks: HookRegistry;
}

/**
 * Presentation-neutral events emitted during one agent run.
 * CLI and future TUI render these independently.
 * All message/tool-call types are agent-layer, not ai-layer.
 */
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
  | { readonly type: "tool_end";        readonly call: AgentToolCall; readonly result: AgentToolResult };
