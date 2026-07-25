import type { AssistantMessage, Message, ModelConfig, ToolCall } from "../ai/types.js";
import type { AgentToolResult } from "./tools/types.js";

/**
 * Callbacks that the agent loop invokes at lifecycle points.
 * Each callback is optional and receives only the data it needs.
 */
export interface AgentLoopConfig {
  /** Before pushing the user message. Return { block } to reject. */
  onUserPrompt?: (prompt: string) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** Before each LLM stream. Return { context } to inject as a user message. */
  onPreTurn?: () => Promise<{ context: string } | undefined>;
  /** Before executing a tool. Return { block } to skip with an error. */
  onBeforeTool?: (call: ToolCall) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** After executing a tool. Side-effect only. */
  onAfterTool?: (call: ToolCall, result: AgentToolResult) => Promise<void>;
  /** After an assistant message with no tool calls. */
  onStop?: (messages: readonly Message[]) => Promise<{
    messages?: readonly Message[]; forceContinue?: string;
  } | undefined>;
}

/**
 * Presentation-neutral events emitted during one agent run.
 * CLI and future TUI render these independently.
 */
export type AgentEvent =
  // Run lifecycle
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end";   readonly messages: readonly Message[] }
  // Turn lifecycle
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end";    readonly message: AssistantMessage }
  // Streaming content
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: ToolCall }
  // Tool execution
  | { readonly type: "tool_start";      readonly call: ToolCall }
  | { readonly type: "tool_end";        readonly call: ToolCall; readonly result: AgentToolResult };

/** Public read-only snapshot of the Agent's current state. */
export interface AgentState {
  readonly messages: readonly Message[];
  readonly model: ModelConfig;
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
