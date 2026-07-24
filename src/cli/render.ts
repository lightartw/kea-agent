import type { AgentEvent } from "../agent/types.js";

/** Convert presentation-neutral agent events into the current line-based UI. */
export function renderAgentEvent(
  event: AgentEvent,
  write: (text: string) => void,
  log: (text: string) => void,
): void {
  switch (event.type) {
    case "text_delta":
      write(event.text);
      break;
    case "thinking_delta":
      write(`\x1b[90m${event.thinking}\x1b[0m`); // grey
      break;
    case "toolcall_start":
      log(`\n\x1b[33m[tool] ${event.name}\x1b[0m`); // yellow
      break;
    case "toolcall_delta":
      write(event.argumentsDelta);
      break;
    case "toolcall_end":
      // tool call complete -- already displayed via deltas
      break;
    case "tool_start":
      log(
        `\n\x1b[33m[exec] ${event.call.name}: ${JSON.stringify(event.call.arguments)}\x1b[0m`,
      );
      break;
    case "tool_end":
      // result preview
      break;
    case "turn_end":
    case "turn_start":
    case "agent_start":
    case "agent_end":
      // Lifecycle events — no terminal output needed
      break;
  }
}
