const MIN_PORT = 1;
const MAX_PORT = 65535;

function clampRange(from: number, to: number): number[] {
  const lo = Math.max(MIN_PORT, Math.min(from, to));
  const hi = Math.min(MAX_PORT, Math.max(from, to));
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}

function parseToken(token: string): number[] {
  const stripped = token.replace(/^[TU]:/i, '').trim();
  if (stripped === '') return [];

  if (stripped === '-') return clampRange(MIN_PORT, MAX_PORT);

  const dash = stripped.indexOf('-');
  if (dash >= 0) {
    const leftRaw = stripped.slice(0, dash).trim();
    const rightRaw = stripped.slice(dash + 1).trim();
    const left = leftRaw === '' ? MIN_PORT : Number(leftRaw);
    const right = rightRaw === '' ? MAX_PORT : Number(rightRaw);
    if (!Number.isInteger(left) || !Number.isInteger(right)) return [];
    return clampRange(left, right);
  }

  const port = Number(stripped);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return [];
  return [port];
}

export function parsePortSpec(spec: string): number[] {
  const seen = new Set<number>();
  for (const token of spec.split(',')) {
    for (const port of parseToken(token)) seen.add(port);
  }
  return [...seen].sort((a, b) => a - b);
}
