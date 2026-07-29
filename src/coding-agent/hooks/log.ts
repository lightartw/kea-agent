import type { CodingHookRegistry } from "./types.js";

/**
 * Register a global observer that logs every tool_call attempt.
 * Because observers run before control handlers, even a call that is
 * later blocked by the Permission Hook will still be logged.
 */
export function registerLogHook(registry: CodingHookRegistry): void {
  registry.registerObserver((event, context) => {
    if (event.type !== "tool_call") return;
    context.ui.notify({
      source: "tool_log",
      level: "info",
      message: `[HOOK] ${event.toolName}(...)`,
    });
  });
}
