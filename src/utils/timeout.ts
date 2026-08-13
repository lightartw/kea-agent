export const MAX_TIMEOUT_MILLISECONDS = 2_147_483_647;

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

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

/** Merge a mandatory timeout signal with an optional caller-provided abort signal. */
export function mergeSignals(
  timeoutSeconds: number,
  callerSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(timeoutSeconds));
  if (callerSignal === undefined) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, callerSignal]);
}

export async function runWithTimeout<T>(
  timeoutSeconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new TimeoutError("Operation timed out");
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    timeoutMilliseconds(timeoutSeconds),
  );

  const mergedSignal = callerSignal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, callerSignal]);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(mergedSignal.reason);
    mergedSignal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([operation(mergedSignal), aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      mergedSignal.removeEventListener("abort", onAbort);
    }
  }
}
