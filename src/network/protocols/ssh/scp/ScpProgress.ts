export function scpProgressLine(name: string, bytes: number, limitKbit: number | null = null): string {
  const seconds = limitKbit === null ? 0 : Math.round((bytes * 8) / (limitKbit * 1000));
  const rate = limitKbit === null ? bytes : Math.floor(bytes / Math.max(seconds, 1));
  const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return `${name.padEnd(40)}100% ${String(bytes).padStart(5)}     ${scaleRate(rate)}   ${elapsed}`;
}

function scaleRate(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB/s`;
  return `${bytes}B/s`;
}
