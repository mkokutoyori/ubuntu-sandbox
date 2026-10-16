export type ZoneOffset = (atMs: number) => number;

const FIELDS = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/;

export function parseAbsoluteTime(text: string, zoneOffsetMinutes: ZoneOffset): number | null {
  if (![8, 12, 14].includes(text.length)) return null;
  const match = FIELDS.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((field) => (field === undefined ? 0 : Number(field)));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 61) return null;
  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const seconds = Math.floor((wallClockMs - zoneOffsetMinutes(wallClockMs) * 60000) / 1000);
  return seconds < 0 ? null : seconds;
}

export function formatAbsoluteTime(seconds: number, zoneOffsetMinutes: ZoneOffset): string {
  const local = new Date(seconds * 1000 + zoneOffsetMinutes(seconds * 1000) * 60000);
  return local.toISOString().slice(0, 19);
}
