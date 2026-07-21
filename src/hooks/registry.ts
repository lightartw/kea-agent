import {
  Hook,
  type HookContext,
  type HookEvent,
  type HookResult,
} from "./types.js";

export class HookRegistry {
  private readonly hooks = new Map<HookEvent["type"], Hook[]>();
  private readonly names = new Set<string>();

  constructor(private readonly context: HookContext) {}

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

  async trigger<TEvent extends HookEvent>(event: TEvent): Promise<HookResult> {
    const hooks = this.hooks.get(event.type) ?? [];
    for (const hook of hooks) {
      try {
        const result = await (hook as Hook<TEvent>).execute(event, this.context);
        if (result?.block === true) return result;
      } catch (error) {
        throw new Error(`hook '${hook.name}' failed`, { cause: error });
      }
    }
    return undefined;
  }
}
