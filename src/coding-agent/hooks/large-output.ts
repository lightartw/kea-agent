import type { CodingHookRegistry } from "./types.js";

const LARGE_OUTPUT_THRESHOLD = 100_000;

/**
 * Register a global observer that warns when a tool result is unusually
 * large. The threshold is strictly greater than 100,000 characters.
 * It does not truncate or patch the result — it only notifies.
 */
export function registerLargeOutputHook(registry: CodingHookRegistry): void {
  registry.registerObserver((event, context) => {
    if (event.type !== "tool_result") return;
    if (event.content.length > LARGE_OUTPUT_THRESHOLD) {
      context.ui.notify({
        source: "large_output",
        level: "warning",
        message: `[HOOK] ⚠ Large output from ${event.toolName} (${event.content.length} characters)`,
      });
    }
  });
}
