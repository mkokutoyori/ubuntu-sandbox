export interface ContentHolder {
  content: string;
  size: number;
}

export function deferContent(holder: ContentHolder, produce: () => string, declaredSize: number): void {
  holder.size = declaredSize;
  Object.defineProperty(holder, 'content', {
    configurable: true,
    enumerable: true,
    get(): string {
      const value = produce();
      Object.defineProperty(holder, 'content', { value, writable: true, enumerable: true, configurable: true });
      holder.size = value.length;
      return value;
    },
    set(value: string) {
      Object.defineProperty(holder, 'content', { value, writable: true, enumerable: true, configurable: true });
    },
  });
}
