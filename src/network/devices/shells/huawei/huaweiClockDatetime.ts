const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const CALENDAR_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

export function vrpDatetimeToEpochMs(args: readonly string[]): number | null {
  const time = TIME_OF_DAY.exec((args[0] ?? '').trim());
  const day = CALENDAR_DAY.exec((args[1] ?? '').trim());
  if (!time || !day) return null;

  const month = Number.parseInt(day[2], 10);
  const dayOfMonth = Number.parseInt(day[3], 10);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;

  return Date.UTC(
    Number.parseInt(day[1], 10), month - 1, dayOfMonth,
    Number.parseInt(time[1], 10), Number.parseInt(time[2], 10),
    time[3] === undefined ? 0 : Number.parseInt(time[3], 10),
  );
}
