export interface WeightedValue {
  value: string;
  q: number;
}

// RFC 9110 §12.4.2 — weighted list syntax shared by Accept/Accept-Language/Accept-Encoding.
export function parseWeightedList(header: string): WeightedValue[] {
  return header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [value, ...params] = part.split(';').map((s) => s.trim());
      let q = 1;
      for (const param of params) {
        const [k, v] = param.split('=').map((s) => s.trim());
        if (k === 'q') {
          const parsed = parseFloat(v);
          if (!isNaN(parsed)) q = Math.min(1, Math.max(0, parsed));
        }
      }
      return { value, q };
    });
}

function specificityOf(pattern: string): number {
  if (pattern === '*' || pattern === '*/*') return 0;
  if (pattern.endsWith('/*')) return 1;
  return 2;
}

function matches(pattern: string, candidate: string): boolean {
  if (pattern === '*') return true;
  if (pattern === candidate) return true;
  if (pattern.endsWith('/*')) {
    const type = pattern.slice(0, -2);
    return candidate.startsWith(`${type}/`);
  }
  return false;
}

// The most specific matching rule is authoritative for a candidate, even if it
// carries q=0 — an explicit rejection overrides a permissive wildcard (RFC 9110 §12.5.1).
function effectiveQFor(weighted: WeightedValue[], candidate: string): number {
  let bestSpecificity = -1;
  let q = 0;
  for (const w of weighted) {
    if (matches(w.value, candidate) && specificityOf(w.value) > bestSpecificity) {
      bestSpecificity = specificityOf(w.value);
      q = w.q;
    }
  }
  return q;
}

/**
 * Picks the highest-weighted candidate the client will accept. Ties keep the
 * server's own preference order (the order of `available`). An absent header
 * means no preference was stated, so the server's first choice wins.
 */
export function selectBestMatch(headerValue: string | undefined, available: string[]): string | null {
  if (headerValue === undefined) return available[0] ?? null;
  const weighted = parseWeightedList(headerValue);
  const scored = available
    .map((candidate) => ({ candidate, q: effectiveQFor(weighted, candidate) }))
    .filter((entry) => entry.q > 0);
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.q - a.q);
  return scored[0].candidate;
}
