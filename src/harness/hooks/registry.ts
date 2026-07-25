import type { Hook, HookEvent, HookResult } from "./types.js";

export class HookRegistry {
  private readonly hooks = new Map<string, Hook>();

  register(hook: Hook): void {
    if (this.hooks.has(hook.name)) {
      throw new Error(`hook '${hook.name}' is already registered`);
    }
    this.hooks.set(hook.name, hook);
  }

  get<T extends Hook = Hook>(name: string): T | undefined {
    return this.hooks.get(name) as T | undefined;
  }

  values(): IterableIterator<Hook> {
    return this.hooks.values();
  }

  async trigger<TEvent extends HookEvent>(event: TEvent): Promise<HookResult | undefined> {
    for (const hook of this.hooks.values()) {
      if (hook.eventType !== event.type) continue;
      try {
        const result = await (hook as Hook<TEvent>).execute(event);
        if (result !== undefined && result !== null) return result;
      } catch (error) {
        throw new Error(`hook '${hook.name}' failed`, { cause: error });
      }
    }
    return undefined;
  }
}
