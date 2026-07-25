/**
 * Push-based stream implementing AsyncIterable. Producer pushes events from
 * a background async task; consumer iterates asynchronously. Construction is
 * synchronous — the producer can start after the consumer begins iterating.
 */
export class EventStream<T> implements AsyncIterable<T> {
  private events: T[] = [];
  private notify: (() => void) | null = null;
  private finished = false;
  private _error: unknown = null;

  push(event: T): void {
    this.events.push(event);
    this.notify?.();
  }

  end(): void {
    this.finished = true;
    this.notify?.();
  }

  error(err: unknown): void {
    this._error = err;
    this.finished = true;
    this.notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let i = 0;
    while (true) {
      // Drain queued events
      while (i < this.events.length) {
        yield this.events[i++]!;
      }
      // Re-throw or exit
      if (this._error) throw this._error;
      if (this.finished) return;
      // Wait for more
      await new Promise<void>((resolve) => { this.notify = resolve; });
    }
  }
}
