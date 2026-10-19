export class ScpByteQueue {
  private queued = new Uint8Array(0);
  private waiting: { count: number | 'line'; resolve: (bytes: Uint8Array | null) => void } | null = null;
  private ended = false;

  push(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.queued.length + bytes.length);
    merged.set(this.queued);
    merged.set(bytes, this.queued.length);
    this.queued = merged;
    this.settle();
  }

  drain(): Uint8Array {
    const taken = this.queued;
    this.queued = new Uint8Array(0);
    return taken;
  }

  end(): void {
    this.ended = true;
    this.settle();
  }

  take(count: number): Promise<Uint8Array | null> {
    return this.wait(count);
  }

  line(): Promise<Uint8Array | null> {
    return this.wait('line');
  }

  private wait(count: number | 'line'): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      this.waiting = { count, resolve };
      this.settle();
    });
  }

  private settle(): void {
    const pending = this.waiting;
    if (pending === null) return;
    if (pending.count === 'line') {
      const newline = this.queued.indexOf(0x0a);
      if (newline >= 0) {
        this.waiting = null;
        const line = this.queued.slice(0, newline + 1);
        this.queued = this.queued.slice(newline + 1);
        pending.resolve(line);
        return;
      }
    } else if (this.queued.length >= pending.count) {
      this.waiting = null;
      const taken = this.queued.slice(0, pending.count);
      this.queued = this.queued.slice(pending.count);
      pending.resolve(taken);
      return;
    }
    if (this.ended) {
      this.waiting = null;
      pending.resolve(null);
    }
  }
}
