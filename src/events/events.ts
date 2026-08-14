import type { EventMap } from "./types.js";

type EventName = keyof EventMap & string;
type ContractOf<TName extends EventName> = EventMap[TName];

type FactEventName = {
  [TName in EventName]: Parameters<ContractOf<TName>> extends [infer TInput]
    ? ReturnType<ContractOf<TName>> extends void | Promise<void>
      ? TName
      : never
    : never;
}[EventName];

type InterceptEventName = {
  [TName in EventName]: Parameters<ContractOf<TName>> extends [
    unknown,
    unknown,
    ...unknown[],
  ]
    ? TName
    : never;
}[EventName];

type FactInput<TName extends EventName> =
  Parameters<ContractOf<TName>> extends [infer TInput]
    ? TInput
    : never;

type InterceptInput<TName extends EventName> =
  Parameters<ContractOf<TName>> extends [infer TInput, unknown, ...unknown[]]
    ? TInput
    : never;

type InterceptResult<TName extends EventName> =
  ReturnType<ContractOf<TName>> extends infer TResult
    ? Awaited<TResult>
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
    listener: EventMap[TName],
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

  async emit<TName extends FactEventName>(
    name: TName,
    input: FactInput<TName>,
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
    input: InterceptInput<TName>,
    handler: (
      input: InterceptInput<TName>,
    ) => InterceptResult<TName> | Promise<InterceptResult<TName>>,
    signal?: AbortSignal,
  ): Promise<InterceptResult<TName>> {
    signal?.throwIfAborted();
    const snapshot = [...(this.#listeners.get(name) ?? [])];
    const run = async (
      index: number,
      value: InterceptInput<TName>,
    ): Promise<InterceptResult<TName>> => {
      signal?.throwIfAborted();
      const registration = snapshot[index];
      if (registration === undefined) {
        const result = await handler(value as InterceptInput<TName>);
        signal?.throwIfAborted();
        return result as InterceptResult<TName>;
      }
      let proceedCalled = false;
      const proceed = (
        changedInput: InterceptInput<TName>,
      ): Promise<InterceptResult<TName>> => {
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
      return returned as InterceptResult<TName>;
    };
    return run(0, input);
  }

  #reportListenerError(error: unknown, name: string, input: unknown): void {
    try {
      this.#onListenerError?.(error, name, input);
    } catch {
      // The diagnostic boundary cannot change fact delivery.
    }
  }
}
