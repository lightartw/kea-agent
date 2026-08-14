import type {
  AskEventName,
  EmitEventName,
  EventDispatch,
  EventInput,
  EventListener,
  EventListenerErrorHandler,
  EventName,
  EventResult,
  TransformEventName,
  Unregister,
} from "./types.js";

type AnyListener = (...args: never[]) => unknown;

/** One independent registration; unregister() removes this object, not the function. */
interface ListenerRegistration {
  readonly listener: AnyListener;
}

export class Events {
  readonly #listeners = new Map<string, Set<ListenerRegistration>>();
  readonly #onListenerError: EventListenerErrorHandler | undefined;

  constructor(onListenerError?: EventListenerErrorHandler) {
    this.#onListenerError = onListenerError;
  }

  on<TName extends EventName>(
    name: TName,
    listener: EventListener<TName>,
  ): Unregister {
    let registrations = this.#listeners.get(name);
    if (registrations === undefined) {
      registrations = new Set();
      this.#listeners.set(name, registrations);
    }
    const registration: ListenerRegistration = {
      listener: listener as unknown as AnyListener,
    };
    registrations.add(registration);
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      registrations?.delete(registration);
    };
  }

  async emit<TName extends EmitEventName>(
    name: TName,
    input: EventInput<TName>,
  ): Promise<void> {
    const snapshot = [...(this.#listeners.get(name) ?? [])];
    for (const registration of snapshot) {
      try {
        await registration.listener(input as never);
      } catch (error) {
        this.#reportListenerError(error, { name, input });
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
    for (const registration of snapshot) {
      const answer = await registration.listener(input as never, signal as never);
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
      const registration = snapshot[index];
      if (registration === undefined) return value;
      let nextCalled = false;
      const next = (nextValue: EventResult<TName>): Promise<EventResult<TName>> => {
        if (nextCalled) {
          throw new Error(`transform listener for ${name} called next() more than once`);
        }
        nextCalled = true;
        return run(index + 1, nextValue);
      };
      const returned = await registration.listener(
        value as never,
        next as never,
        signal as never,
      );
      signal?.throwIfAborted();
      return returned as EventResult<TName>;
    };
    return run(0, input as unknown as EventResult<TName>);
  }

  /** Terminal diagnostic boundary: a failing reporter must not change fact delivery. */
  #reportListenerError(error: unknown, dispatch: EventDispatch): void {
    try {
      this.#onListenerError?.(error, dispatch);
    } catch {
      // The diagnostic boundary cannot change fact delivery.
    }
  }
}
