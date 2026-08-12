import type { CodingHookRegistry } from "./types.js";

/**
 * Register a global listener that logs every tool_call attempt.
 * Because listeners run before control handlers, even a call that is
 * later blocked by the Permission Hook will still be logged.
 */
export function registerLogHook(registry: CodingHookRegistry): void {
  registry.registerListener((event, context) => {
    if (event.type !== "tool_call") return;
    context.ui.notify({
      source: "tool_log",
      level: "info",
      message: `[HOOK] ${event.toolName}(...)`,
    });
  });
}
