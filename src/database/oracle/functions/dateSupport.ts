const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MONTH_ABBREVIATIONS = MONTH_NAMES.map(m => m.slice(0, 3));
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DAY_ABBREVIATIONS = DAY_NAMES.map(d => d.slice(0, 3));

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function coerceDateValue(value: unknown): Date | null {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  }
  const ms = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function formatDateValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateWithPattern(d: Date, fmt: string): string {
  let result = fmt;
  result = result.replace(/YYYY/g, String(d.getFullYear()));
  result = result.replace(/YY/g, String(d.getFullYear()).slice(-2));
  result = result.replace(/MONTH/g, MONTH_NAMES[d.getMonth()]);
  result = result.replace(/MON/g, MONTH_ABBREVIATIONS[d.getMonth()]);
  result = result.replace(/MM/g, pad(d.getMonth() + 1));
  result = result.replace(/DD/g, pad(d.getDate()));
  result = result.replace(/DAY/g, DAY_NAMES[d.getDay()]);
  result = result.replace(/DY/g, DAY_ABBREVIATIONS[d.getDay()]);
  result = result.replace(/HH24/g, pad(d.getHours()));
  result = result.replace(/HH/g, pad(d.getHours() % 12 || 12));
  result = result.replace(/MI/g, pad(d.getMinutes()));
  result = result.replace(/SS/g, pad(d.getSeconds()));
  return result;
}

export function parseDateWithPattern(dateStr: string, fmt: string): string {
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.toISOString().slice(0, 19).replace('T', ' ');
  }
  let year = 2000, month = 1, day = 1, hour = 0, min = 0, sec = 0;
  const parts = dateStr.split(/[\s/\-:.,]+/);
  const fmtParts = fmt.toUpperCase().split(/[\s/\-:.,]+/);
  for (let i = 0; i < fmtParts.length && i < parts.length; i++) {
    const v = parseInt(parts[i], 10);
    if (isNaN(v) && fmtParts[i] === 'MON') {
      const idx = MONTH_ABBREVIATIONS.indexOf(parts[i].toUpperCase().slice(0, 3));
      if (idx >= 0) month = idx + 1;
      continue;
    }
    if (isNaN(v)) continue;
    switch (fmtParts[i]) {
      case 'YYYY': year = v; break;
      case 'YY': year = 2000 + v; break;
      case 'MM': month = v; break;
      case 'DD': day = v; break;
      case 'HH24': case 'HH': hour = v; break;
      case 'MI': min = v; break;
      case 'SS': sec = v; break;
    }
  }
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
}
