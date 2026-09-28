const DAY_SECONDS = 86_400;
const WEEK_DAYS = 7;
const YEAR_DAYS = 365;

export function formatIosElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000));
  const two = (value: number) => String(value).padStart(2, '0');
  const days = Math.floor(total / DAY_SECONDS);
  if (days < 1) return `${two(Math.floor(total / 3_600))}:${two(Math.floor((total % 3_600) / 60))}:${two(total % 60)}`;
  if (days < WEEK_DAYS) return `${days}d${two(Math.floor((total % DAY_SECONDS) / 3_600))}h`;
  if (days < YEAR_DAYS) return `${Math.floor(days / WEEK_DAYS)}w${days % WEEK_DAYS}d`;
  return `${Math.floor(days / YEAR_DAYS)}y${two(Math.floor((days % YEAR_DAYS) / WEEK_DAYS))}w`;
}
