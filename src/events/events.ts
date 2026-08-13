import type {
  AskEventName,
  EmitEventName,
  EventInput,
  EventListener,
  EventListenerErrorHandler,
  EventName,
  EventResult,
  TransformEventName,
  Unregister,
} from "./types.js";

type AnyListener = (input: never, extra: never, signal?: AbortSignal) => unknown;

export class Events {
  readonly #listeners = new Map<string, Set<AnyListener>>();
  readonly #onListenerError: EventListenerErrorHandler | undefined;

  constructor(onListenerError?: EventListenerErrorHandler) {
    this.#onListenerError = onListenerError;
  }

  on<TName extends EventName>(
    name: TName,
    listener: EventListener<TName>,
  ): Unregister {
    let listeners = this.#listeners.get(name);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    const wrapped = listener as unknown as AnyListener;
    listeners.add(wrapped);
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      listeners?.delete(wrapped);
    };
  }

  async emit<TName extends EmitEventName>(
    name: TName,
    input: EventInput<TName>,
  ): Promise<void> {
    const snapshot = [...(this.#listeners.get(name) ?? [])];
    for (const listener of snapshot) {
      try {
        await listener(input as never, undefined as never);
      } catch (error) {
        this.#onListenerError?.(error, { name, input });
      }
    }
  }

  async ask<TName extends AskEventName>(
    name: TName,
    input: EventInput<TName>,
    signal?: AbortSignal,
  ): Promise<EventResult<TName> | undefined> {
    signal?.throwIfAborted();
    const snapshot = [...(this.#listeners.get(name) ?? [])];
    for (const listener of snapshot) {
      const answer = await listener(input as never, undefined as never, signal);
      signal?.throwIfAborted();
      if (answer !== undefined) return answer as EventResult<TName>;
    }
    return undefined;
  }

  async transform<TName extends TransformEventName>(
    name: TName,
    input: EventInput<TName>,
    signal?: AbortSignal,
  ): Promise<EventResult<TName>> {
    signal?.throwIfAborted();
    const snapshot = [...(this.#listeners.get(name) ?? [])];
    const run = async (
      index: number,
      value: EventResult<TName>,
    ): Promise<EventResult<TName>> => {
      signal?.throwIfAborted();
      const listener = snapshot[index];
      if (listener === undefined) return value;
      let continued = false;
      let chained: Promise<EventResult<TName>> | undefined;
      const next = (nextValue: EventResult<TName>): Promise<EventResult<TName>> => {
        continued = true;
        const result = run(index + 1, nextValue);
        chained = result;
        return result;
      };
      const returned = await listener(
        value as never,
        next as never,
        signal,
      );
      signal?.throwIfAborted();
      if (continued) return (await chained) as EventResult<TName>;
      return returned as EventResult<TName>;
    };
    return run(0, input as unknown as EventResult<TName>);
  }
}
