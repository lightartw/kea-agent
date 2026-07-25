import type { HookHandler, ReduceStrategy } from "./types.js";

const DEFAULT_REDUCERS: Record<string, ReduceStrategy> = {
  tool_call: "earlyExit",
  context: "transform",
  tool_result: "patch",
  turn_end: "observe",
  user_prompt: "earlyExit",
  pre_turn: "observe",
};

/**
 * Unified hook registry. Handlers are registered per event type string.
 * When `trigger(type, event)` is called, handlers run serially
 * and results are reduced according to the strategy configured for that type.
 */
export class HookRegistry {
  private readonly handlers = new Map<string, Set<HookHandler>>();
  private readonly reducers: Record<string, ReduceStrategy>;

  constructor(reducers?: Record<string, ReduceStrategy>) {
    this.reducers = { ...DEFAULT_REDUCERS, ...reducers };
  }

  /** Register a handler. Returns an unsubscribe function. */
  register(type: string, handler: HookHandler): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Trigger all handlers for `type` and reduce results per the configured strategy. */
  async trigger(type: string, event: unknown): Promise<unknown> {
    const set = this.handlers.get(type);
    if (set === undefined || set.size === 0) return undefined;

    const strategy = this.reducers[type] ?? "observe";

    switch (strategy) {
      case "earlyExit":
        return this.reduceEarlyExit(set, event);
      case "transform":
        return this.reduceTransform(set, event);
      case "patch":
        return this.reducePatch(set, event);
      case "observe":
        await this.reduceObserve(set, event);
        return undefined;
    }
  }

  private async reduceEarlyExit(
    handlers: Set<HookHandler>,
    event: unknown,
  ): Promise<unknown> {
    for (const handler of handlers) {
      const result = await handler(event);
      if (result !== undefined && result !== null) return result;
    }
    return undefined;
  }

  private async reduceTransform(
    handlers: Set<HookHandler>,
    initial: unknown,
  ): Promise<unknown> {
    let value = initial;
    for (const handler of handlers) {
      const result = await handler(value);
      if (result !== undefined && result !== null) value = result;
    }
    return value;
  }

  private async reducePatch(
    handlers: Set<HookHandler>,
    event: unknown,
  ): Promise<unknown> {
    let accumulated: Record<string, unknown> = {};
    for (const handler of handlers) {
      const patch = await handler(event);
      if (patch !== undefined && patch !== null) {
        accumulated = { ...accumulated, ...(patch as Record<string, unknown>) };
      }
    }
    return Object.keys(accumulated).length > 0 ? accumulated : undefined;
  }

  private async reduceObserve(
    handlers: Set<HookHandler>,
    event: unknown,
  ): Promise<void> {
    for (const handler of handlers) {
      await handler(event);
    }
  }
}
