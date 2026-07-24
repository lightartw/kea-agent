import type { AssistantMessage } from "../llm-client/types.js";
import type { ToolCall, ToolResult } from "./tools/types.js";

/**
 * Presentation-neutral events emitted during one agent turn.
 * CLI and future TUI render these independently; core modules never
 * import presentation code.
 */
export type AgentEvent =
  | { readonly type: "text_delta";      readonly text: string }
  | { readonly type: "thinking_delta";  readonly thinking: string }
  | { readonly type: "toolcall_start";  readonly id: string; readonly name: string }
  | { readonly type: "toolcall_delta";  readonly id: string; readonly argumentsDelta: string }
  | { readonly type: "toolcall_end";    readonly toolCall: ToolCall }
  | { readonly type: "tool_start";      readonly call: ToolCall }
  | { readonly type: "tool_end";        readonly call: ToolCall; readonly result: ToolResult }
  | { readonly type: "turn_end";        readonly message: AssistantMessage };
