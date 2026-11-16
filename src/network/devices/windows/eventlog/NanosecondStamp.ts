export function nanosecondStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.${String(ms % 1000).padStart(3, '0')}000000Z`;
}
