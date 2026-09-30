/**
 * Calls answered by a later message: each gets an id to send along, and
 * settles when a reply with that id arrives — or rejects once `timeoutMs`
 * passes without one, so a frame or window that never answers can't leave a
 * caller waiting forever.
 */
export class PendingCalls<T> {
  private calls = new Map<number, { resolve: (value: T) => void; timer: ReturnType<typeof setTimeout> }>();
  private next = 1;
  private readonly timeoutMs: number;
  private readonly timeoutMessage: string;

  constructor(timeoutMs: number, timeoutMessage = "timed out") {
    this.timeoutMs = timeoutMs;
    this.timeoutMessage = timeoutMessage;
  }

  /** Start a call: `send` gets its id and sends the request. */
  start(send: (id: number) => void): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(this.timeoutMessage));
      }, this.timeoutMs);
      this.calls.set(id, { resolve, timer });
      send(id);
    });
  }

  /** The reply to call `id` arrived. Unknown or settled ids are ignored. */
  settle(id: unknown, value: T) {
    const call = typeof id === "number" ? this.calls.get(id) : undefined;
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(id as number);
    call.resolve(value);
  }
}
