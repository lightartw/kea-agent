import type { CodingHookRegistry } from "./types.js";

/**
 * Register a stop handler that counts tool messages in the session
 * and notifies the UI. It always returns undefined so the Agent
 * terminates naturally.
 */
export function registerSummaryHook(registry: CodingHookRegistry): void {
  registry.register("stop", (event, context) => {
    const toolCount = event.messages.filter(
      (message) => message.role === "tool",
    ).length;
    context.ui.notify({
      source: "summary",
      level: "info",
      message: `[HOOK] Stop: session used ${toolCount} tool calls`,
    });
    return undefined;
  });
}
