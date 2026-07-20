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

export async function runWithTimeout<T>(
  timeoutSeconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new TimeoutError("Operation timed out");
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    timeoutMilliseconds(timeoutSeconds),
  );

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
}
