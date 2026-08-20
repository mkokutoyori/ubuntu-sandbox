export function isIanaTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function timezoneOffsetMinutes(name: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: name, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs));

  const field = (type: string): number =>
    Number.parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  const asUtc = Date.UTC(
    field('year'), field('month') - 1, field('day'),
    field('hour') % 24, field('minute'), field('second'),
  );
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

export function localTimeMs(name: string, atMs: number): number {
  return atMs + timezoneOffsetMinutes(name, atMs) * 60_000;
}

export function utcMsForLocal(name: string, localMs: number): number {
  const guess = localMs - timezoneOffsetMinutes(name, localMs) * 60_000;
  return localMs - timezoneOffsetMinutes(name, guess) * 60_000;
}
