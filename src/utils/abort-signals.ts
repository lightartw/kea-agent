export interface CombinedAbortSignal {
  signal?: AbortSignal;
  cleanup: () => void;
}

export const MAX_TIMEOUT_MILLISECONDS = 2_147_483_647;

export function timeoutMilliseconds(timeoutSeconds: number): number {
  const milliseconds = Math.ceil(timeoutSeconds * 1_000);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > MAX_TIMEOUT_MILLISECONDS
  ) {
    throw new RangeError("timeout exceeds the Node timer range");
  }
  return milliseconds;
}

export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): CombinedAbortSignal {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );

  if (activeSignals.length === 0) {
    return { cleanup: () => undefined };
  }

  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0]!,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }

    const listener = (): void => controller.abort(signal.reason);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.clear();
    },
  };
}

export function raceWithSignal<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function closeAsyncIterator(
  iterator: AsyncIterator<unknown> | undefined,
): void {
  if (iterator?.return === undefined) return;
  try {
    const closing = iterator.return();
    void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // Stream shutdown must not replace the request's primary outcome.
  }
}
