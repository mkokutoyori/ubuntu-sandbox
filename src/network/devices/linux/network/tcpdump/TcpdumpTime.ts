const UNITS: ReadonlyArray<readonly [string, number]> = [
  ['y', 31536000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1],
];

export function unsignedRelativeTime(seconds: number): string {
  if (seconds === 0) return '0s';
  let remaining = seconds;
  let text = '';
  for (const [unit, size] of UNITS) {
    if (remaining >= size) {
      text += `${Math.floor(remaining / size)}${unit}`;
      remaining -= Math.floor(remaining / size) * size;
    }
  }
  return text;
}
