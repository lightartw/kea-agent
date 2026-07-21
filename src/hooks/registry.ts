import {
  Hook,
  type HookContext,
  type HookEvent,
  type HookResult,
} from "./types.js";

/** Stores hooks by lifecycle event and runs each event's hooks in registration order. */
export class HookRegistry {
  private readonly hooks = new Map<HookEvent["type"], Hook[]>();
  private readonly names = new Set<string>();

  constructor(private readonly context: HookContext) {}

  /** Hook names are unique so configuration and error messages stay unambiguous. */
  register(hook: Hook): void {
    if (this.names.has(hook.name)) {
      throw new Error(`hook '${hook.name}' is already registered`);
    }
    this.names.add(hook.name);
    const hooks = this.hooks.get(hook.eventType) ?? [];
    hooks.push(hook);
    this.hooks.set(hook.eventType, hooks);
  }

  unregister(name: string): void {
    this.names.delete(name);
    for (const [eventType, hooks] of this.hooks) {
      const remaining = hooks.filter((hook) => hook.name !== name);
      if (remaining.length === 0) this.hooks.delete(eventType);
      else this.hooks.set(eventType, remaining);
    }
  }

  /**
   * Run one lifecycle event until every hook passes or one blocks it.
   * Hook failures are rethrown with the hook name; the tool layer treats them
   * as a failed-closed result and never executes the requested operation.
   */
  async trigger<TEvent extends HookEvent>(event: TEvent): Promise<HookResult> {
    const hooks = this.hooks.get(event.type) ?? [];
    for (const hook of hooks) {
      try {
        // The event-type map guarantees hooks in this bucket accept TEvent.
        const result = await (hook as Hook<TEvent>).execute(event, this.context);
        if (result?.block === true) return result;
      } catch (error) {
        throw new Error(`hook '${hook.name}' failed`, { cause: error });
      }
    }
    return undefined;
  }
}
