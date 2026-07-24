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

  /** All registered hooks. */
  values(): IterableIterator<Hook> {
    return this.hooks.values();
  }

  /**
   * Run one lifecycle event through every hook registered for that event type.
   * The first hook that returns a non-void result stops the chain — matching the
   * user's model: "return None (= undefined) to continue, return something to stop."
   * Failures are rethrown with the hook name so each lifecycle caller can
   * apply its own failure policy.
   */
  async trigger<TEvent extends HookEvent>(event: TEvent): Promise<HookResult | undefined> {
    for (const hook of this.hooks.values()) {
      if (hook.eventType !== event.type) continue;
      try {
        // The discriminator check above selects hooks specialised for TEvent.
        const result = await (hook as Hook<TEvent>).execute(event);
        if (result !== undefined && result !== null) return result;
      } catch (error) {
        throw new Error(`hook '${hook.name}' failed`, { cause: error });
      }
    }
    return undefined;
  }
}
