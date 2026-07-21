import type { ToolCall } from "../tools/types.js";
import type { HookResult, PreToolUseHook } from "./types.js";

/** Runs pre-tool hooks in registration order and stops at the first block. */
export class HookRegistry {
  private readonly hooks = new Map<string, PreToolUseHook>();

  /** Hook names are unique so configuration and error messages stay unambiguous. */
  register(hook: PreToolUseHook): void {
    if (this.hooks.has(hook.name)) {
      throw new Error(`hook '${hook.name}' is already registered`);
    }
    this.hooks.set(hook.name, hook);
  }

  /**
   * Run one validated call through every registered pre-tool hook.
   * Hook failures are rethrown with the hook name; the tool layer treats them
   * as a failed-closed result and never executes the requested operation.
   */
  async triggerPreToolUse(call: ToolCall): Promise<HookResult> {
    for (const hook of this.hooks.values()) {
      try {
        const result = await hook.execute(call);
        if (result?.block === true) return result;
      } catch (error) {
        throw new Error(`hook '${hook.name}' failed`, { cause: error });
      }
    }
    return undefined;
  }
}
