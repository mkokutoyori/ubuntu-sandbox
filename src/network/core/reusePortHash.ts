export function reusePortHash(ip: string, port: number): number {
  let hash = 2166136261;
  for (const char of `${ip}:${port}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}
