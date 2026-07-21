import type { AgentEvent } from "../agent/types.js";

const CYAN = "[36m";
const RESET = "[0m";

/** Convert presentation-neutral agent events into the current line-based UI. */
export function renderAgentEvent(
  event: AgentEvent,
  write: (text: string) => void,
  log: (text: string) => void,
): void {
  if (event.type === "text_delta") {
    write(event.text);
  } else if (event.type === "tool_start") {
    log(
      `\n[33m[tool] $ ${event.call.name}: ${JSON.stringify(event.call.arguments)}[0m`,
    );
  } else if (event.type === "tool_end") {
    const label = event.result.isError ? "[31m[tool error]" : "[90m[tool result]";
    log(`${label} ${event.call.name}[0m\n${event.result.content.slice(0, 200)}`);
  }
}
