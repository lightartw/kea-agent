import type { CodingHookRegistry } from "./types.js";

/**
 * Register a user_prompt handler that notifies the UI of the current
 * working directory. The system prompt already contains cwd, so this
 * handler does not inject it again — it only sends a teaching notification.
 */
export function registerContextInjectHook(registry: CodingHookRegistry): void {
  registry.register("user_prompt", (_event, context) => {
    context.ui.notify({
      source: "context_inject",
      level: "info",
      message: `[HOOK] UserPromptSubmit: working in ${context.cwd}`,
    });
    return undefined;
  });
}
