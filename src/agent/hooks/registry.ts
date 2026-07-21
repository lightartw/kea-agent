import type { Hook, HookEvent, HookResult } from "./types.js";

/** Registers generic lifecycle hooks and runs matching hooks in order. */
export class HookRegistry {
  private readonly hooks = new Map<string, Hook>();

  /** Hook names are unique so configuration and error messages stay unambiguous. */
  register(hook: Hook): void {
    if (this.hooks.has(hook.name)) {
      throw new Error(`hook '${hook.name}' is already registered`);
    }
    this.hooks.set(hook.name, hook);
  }

  /** Retrieve a registered hook by name so callers can configure it post-creation. */
  get<T extends Hook = Hook>(name: string): T | undefined {
    return this.hooks.get(name) as T | undefined;
  }

  /**
   * Run one lifecycle event through every hook registered for that event type.
   * Failures are rethrown with the hook name so each lifecycle caller can
   * apply its own failure policy.
   */
  async trigger<TEvent extends HookEvent>(event: TEvent): Promise<HookResult> {
    for (const hook of this.hooks.values()) {
      if (hook.eventType !== event.type) continue;
      try {
        // The discriminator check above selects hooks specialized for TEvent.
        const result = await (hook as Hook<TEvent>).execute(event);
        if (result?.block === true) return result;
      } catch (error) {
        throw new Error(`hook '${hook.name}' failed`, { cause: error });
      }
    }
    return undefined;
  }
}
