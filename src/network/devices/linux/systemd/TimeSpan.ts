const UNIT_SECONDS: Record<string, number> = {
  us: 1e-6, usec: 1e-6,
  ms: 1e-3, msec: 1e-3,
  s: 1, sec: 1, second: 1, seconds: 1,
  m: 60, min: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};

export function parseTimeSpan(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  let total = 0;
  let consumed = '';
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([a-zµ]+)/gi)) {
    const factor = UNIT_SECONDS[match[2].toLowerCase()];
    if (factor === undefined) return undefined;
    total += parseFloat(match[1]) * factor;
    consumed += match[0];
  }
  if (consumed.replace(/\s+/g, '') !== trimmed.replace(/\s+/g, '')) return undefined;
  return total;
}
