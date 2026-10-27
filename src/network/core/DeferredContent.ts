export interface ContentHolder {
  content: string;
  size: number;
}

const pending = new WeakSet<ContentHolder>();

export function isContentDeferred(holder: ContentHolder): boolean {
  return pending.has(holder);
}

export function deferContent(holder: ContentHolder, produce: () => string, declaredSize: number): void {
  holder.size = declaredSize;
  pending.add(holder);
  Object.defineProperty(holder, 'content', {
    configurable: true,
    enumerable: true,
    get(): string {
      pending.delete(holder);
      const value = produce();
      Object.defineProperty(holder, 'content', { value, writable: true, enumerable: true, configurable: true });
      holder.size = value.length;
      return value;
    },
    set(value: string) {
      pending.delete(holder);
      Object.defineProperty(holder, 'content', { value, writable: true, enumerable: true, configurable: true });
    },
  });
}
