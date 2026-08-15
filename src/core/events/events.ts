import type { EmitEvent, EventMap, InterceptEvent } from "./types.js";

type EventName = keyof EventMap & string;

type EmitEventName = {
  [TName in EventName]: EventMap[TName] extends EmitEvent<unknown>
    ? TName
    : never;
}[EventName];

type InterceptEventName = {
  [TName in EventName]: EventMap[TName] extends InterceptEvent<unknown, unknown>
    ? TName
    : never;
}[EventName];

type EventInput<TName extends EventName> =
  EventMap[TName] extends { readonly input: infer TInput }
    ? TInput
    : never;

type EventResult<TName extends EventName> =
  EventMap[TName] extends InterceptEvent<unknown, infer TResult>
    ? TResult
    : never;

type ListenerOf<TName extends EventName> =
  EventMap[TName] extends EmitEvent<infer TInput>
    ? (input: TInput) => void | Promise<void>
    : EventMap[TName] extends InterceptEvent<infer TInput, infer TResult>
      ? (
          input: TInput,
          proceed: (input: TInput) => Promise<TResult>,
          signal?: AbortSignal,
        ) => TResult | Promise<TResult>
      : never;

type AnyListener = (...args: never[]) => unknown;

interface ListenerRegistration {
  readonly listener: AnyListener;
}

export class Events {
  readonly #listeners = new Map<string, Set<ListenerRegistration>>();
  readonly #onListenerError:
    | ((error: unknown, name: string, input: unknown) => void)
    | undefined;

  constructor(
    onListenerError?: (
      error: unknown,
      name: keyof EventMap & string,
      input: unknown,
    ) => void,
  ) {
    this.#onListenerError =
      onListenerError as ((error: unknown, name: string, input: unknown) => void) | undefined;
  }

  on<TName extends EventName>(
    name: TName,
    listener: ListenerOf<TName>,
  ): () => void {
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
        this.#reportListenerError(error, name, input);
      }
    }
  }

  async intercept<TName extends InterceptEventName>(
    name: TName,
    input: EventInput<TName>,
    handler: (
      input: EventInput<TName>,
    ) => EventResult<TName> | Promise<EventResult<TName>>,
    signal?: AbortSignal,
  ): Promise<EventResult<TName>> {
    signal?.throwIfAborted();
    const snapshot = [...(this.#listeners.get(name) ?? [])];
    const run = async (
      index: number,
      value: EventInput<TName>,
    ): Promise<EventResult<TName>> => {
      signal?.throwIfAborted();
      const registration = snapshot[index];
      if (registration === undefined) {
        const result = await handler(value as EventInput<TName>);
        signal?.throwIfAborted();
        return result as EventResult<TName>;
      }
      let proceedCalled = false;
      const proceed = (
        changedInput: EventInput<TName>,
      ): Promise<EventResult<TName>> => {
        if (proceedCalled) {
          throw new Error(`intercept listener for ${name} called proceed() more than once`);
        }
        proceedCalled = true;
        return run(index + 1, changedInput);
      };
      const returned = await registration.listener(
        value as never,
        proceed as never,
        signal as never,
      );
      signal?.throwIfAborted();
      return returned as EventResult<TName>;
    };
    return run(0, input);
  }

  #reportListenerError(error: unknown, name: string, input: unknown): void {
    try {
      this.#onListenerError?.(error, name, input);
    } catch {
      // The error handler cannot change emit delivery.
    }
  }
}
