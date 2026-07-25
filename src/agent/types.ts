import type { Message, ModelConfig } from "../ai/types.js";
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
 * Callbacks and configuration consumed by the agent loop.
 * model, convertToLlm, and hooks are all in one place.
 */
export interface AgentLoopConfig {
  readonly model: ModelConfig;
  /** Convert agent messages to LLM-compatible messages before each stream call. */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];

  /** Before pushing the user message. Return { block } to reject. */
  readonly onUserPrompt?: (prompt: string) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** Before each LLM stream. Return { context } to inject as a user message. */
  readonly onPreTurn?: () => Promise<{ context: string } | undefined>;
  /** Before executing a tool. Return { block } to skip with an error. */
  readonly onBeforeTool?: (call: AgentToolCall) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** After executing a tool. Side-effect only. */
  readonly onAfterTool?: (call: AgentToolCall, result: AgentToolResult) => Promise<void>;
  /** After an assistant message with no tool calls. */
  readonly onStop?: (messages: readonly AgentMessage[]) => Promise<{
    messages?: readonly AgentMessage[];
    forceContinue?: string;
  } | undefined>;
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

/** Public read-only snapshot of the Agent's current state. */
export interface AgentState {
  readonly messages: readonly AgentMessage[];
  readonly model: ModelConfig;
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
