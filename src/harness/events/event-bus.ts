import type {
  HarnessEvent,
  HarnessListener,
  HarnessListenerErrorHandler,
  Unsubscribe,
} from "./types.js";

export class HarnessEventBus {
  private readonly listeners = new Set<HarnessListener>();

  constructor(
    private readonly onListenerError: HarnessListenerErrorHandler = () => undefined,
  ) {}

  subscribe(listener: HarnessListener): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  async publish(event: HarnessEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        try { this.onListenerError(error, event); } catch { /* error reporting is isolated too */ }
      }
    }
  }
}
