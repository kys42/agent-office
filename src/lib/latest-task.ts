/** One request in flight and one latest replacement. Superseded work is never queued forever.
 * The transport may be uncancellable (Electron IPC); stale results cannot reach the caller. */
export class LatestTask<T> {
  private running = false;
  private waiting?: {
    run: () => Promise<T>;
    resolve: (value: T | undefined) => void;
    reject: (error: unknown) => void;
    active: boolean;
  };
  request(run: () => Promise<T>) {
    let item: NonNullable<LatestTask<T>['waiting']>;
    const promise = new Promise<T | undefined>((resolve, reject) => {
      item = { run, resolve, reject, active: true };
    });
    if (this.waiting) {
      this.waiting.active = false;
      this.waiting.resolve(undefined);
    }
    this.waiting = item!;
    void this.drain();
    return {
      promise,
      cancel: () => {
        item.active = false;
        item.resolve(undefined);
      },
    };
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.waiting) {
        const next = this.waiting;
        this.waiting = undefined;
        if (!next.active) continue;
        try {
          const value = await next.run();
          next.resolve(next.active ? value : undefined);
        } catch (error) {
          if (next.active) next.reject(error);
          else next.resolve(undefined);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
