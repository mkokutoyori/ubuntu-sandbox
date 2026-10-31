import type { LineTracker } from './VimSubstitute';

export class VimLineStore extends Array<string> {
  observer: LineTracker | null = null;

  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  static of_lines(lines: readonly string[]): VimLineStore {
    const store = new VimLineStore();
    for (const line of lines) Array.prototype.push.call(store, line);
    return store;
  }

  override splice(start: number, deleteCount?: number, ...items: string[]): string[] {
    const from = start < 0 ? Math.max(this.length + start, 0) : Math.min(start, this.length);
    const removed = deleteCount === undefined ? super.splice(start) : super.splice(start, deleteCount, ...items);
    if (removed.length > 0) this.observer?.deleted(from, removed.length);
    if (items.length > 0) this.observer?.inserted(from, items.length);
    return removed;
  }

  override push(...items: string[]): number {
    const at = this.length;
    const size = super.push(...items);
    if (items.length > 0) this.observer?.inserted(at, items.length);
    return size;
  }

  override unshift(...items: string[]): number {
    const size = super.unshift(...items);
    if (items.length > 0) this.observer?.inserted(0, items.length);
    return size;
  }

  override pop(): string | undefined {
    const at = this.length - 1;
    const removed = super.pop();
    if (removed !== undefined) this.observer?.deleted(at, 1);
    return removed;
  }

  override shift(): string | undefined {
    const removed = super.shift();
    if (removed !== undefined) this.observer?.deleted(0, 1);
    return removed;
  }
}
