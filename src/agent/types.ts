import type { AssistantMessage, Message, ModelConfig, ToolCall } from "../ai/types.js";
import type { ToolResult } from "./tools/types.js";

/**
 * Presentation-neutral events emitted during one agent run.
 * CLI and future TUI render these independently; core modules never
 * import presentation code.
 *
 * Lifecycle: agent_start → turn_start* → ... → turn_end* → agent_end
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
  | { readonly type: "tool_end";        readonly call: ToolCall; readonly result: ToolResult };

/** Public read-only snapshot of the Agent's current state. */
export interface AgentState {
  readonly messages: readonly Message[];
  readonly model: ModelConfig;
  readonly systemPrompt: string;
  readonly isRunning: boolean;
  readonly errorMessage?: string;
}
