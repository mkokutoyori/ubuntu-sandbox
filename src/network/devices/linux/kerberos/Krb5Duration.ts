const UNIT_SECONDS: Readonly<Record<string, number>> = { d: 86400, h: 3600, m: 60, s: 1 };

export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const clock = /^(-?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(trimmed);
  if (clock !== null) {
    const total = Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4] ?? 0);
    return clock[1] === '-' ? -total : total;
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  const signed = /^(-?)(.*)$/.exec(trimmed)!;
  const body = signed[2].replace(/\s+/g, '');
  if (!/^(\d+[dhms])+$/i.test(body)) return null;
  let total = 0;
  for (const part of body.matchAll(/(\d+)([dhms])/gi)) total += Number(part[1]) * UNIT_SECONDS[part[2].toLowerCase()];
  return signed[1] === '-' ? -total : total;
}

export function formatKlistTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getUTCMonth() + 1)}/${two(date.getUTCDate())}/${two(date.getUTCFullYear() % 100)} `
    + `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}
