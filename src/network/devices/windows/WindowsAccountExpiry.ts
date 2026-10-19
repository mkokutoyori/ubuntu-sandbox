import type { DateOrder } from './WindowsRegionalSettings';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) {
    const month = Number(token);
    return month >= 1 && month <= 12 ? month : null;
  }
  const lower = token.toLowerCase();
  if (lower.length < 3) return null;
  const index = MONTHS.findIndex((name) => name.startsWith(lower));
  return index === -1 ? null : index + 1;
}

function expandYear(token: string): number | null {
  if (!/^(\d{2}|\d{4})$/.test(token)) return null;
  const year = Number(token);
  if (token.length === 4) return year;
  return year < 30 ? 2000 + year : 1900 + year;
}

function validDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function parseAccountExpiry(value: string, nowMs: number, order: DateOrder = 'MDY'): Date | null | undefined {
  const text = value.trim();
  if (text.toLowerCase() === 'never') return null;
  const parts = text.split(/[/,]/);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === '')) return undefined;
  const nameFirst = /^[a-z]/i.test(parts[0]);
  const nameSecond = /^[a-z]/i.test(parts[1]);
  let monthToken: string;
  let dayToken: string;
  let yearToken: string | undefined;
  if (nameFirst) {
    [monthToken, dayToken, yearToken] = parts;
  } else if (nameSecond) {
    [dayToken, monthToken, yearToken] = parts;
  } else if (order === 'DMY') {
    [dayToken, monthToken, yearToken] = parts;
  } else if (order === 'YMD' && parts.length === 3) {
    [yearToken, monthToken, dayToken] = parts;
  } else {
    [monthToken, dayToken, yearToken] = parts;
  }
  const month = monthNumber(monthToken);
  if (month === null || !/^\d{1,2}$/.test(dayToken)) return undefined;
  const day = Number(dayToken);
  if (yearToken !== undefined) {
    const year = expandYear(yearToken);
    return year === null ? undefined : validDate(year, month, day) ?? undefined;
  }
  const now = new Date(nowMs);
  const thisYear = validDate(now.getUTCFullYear(), month, day);
  if (thisYear !== null && thisYear.getTime() > nowMs) return thisYear;
  return validDate(now.getUTCFullYear() + 1, month, day) ?? undefined;
}
