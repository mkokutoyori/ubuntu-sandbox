const DAY_NAMES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa', 'wk', 'any', 'al'];
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = DAY_MINUTES * 7;

function digitValue(char: string | undefined): number {
  return char !== undefined && char >= '0' && char <= '9' ? char.charCodeAt(0) - 48 : 0;
}

function leadingInteger(text: string): number {
  const match = /^\s*[+-]?\d+/.exec(text);
  return match === null ? 0 : parseInt(match[0], 10);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function takeDayCode(text: { rest: string }): number {
  for (let index = 0; index < DAY_NAMES.length; index++) {
    if (text.rest.startsWith(DAY_NAMES[index])) {
      text.rest = text.rest.slice(DAY_NAMES[index].length);
      return index;
    }
  }
  return -1;
}

function fillHours(week: Uint8Array, dayOffsetMinutes: number, hours: string): void {
  let end = -1;
  const dash = hours.indexOf('-');
  if (dash >= 0) {
    const after = hours.slice(dash + 1);
    if (dash + 1 !== 5 || after.length < 4 || !isDigit(after[0])) return;
    end = 600 * digitValue(after[0]) + 60 * digitValue(after[1]) + leadingInteger(after.slice(2));
  }
  let start: number;
  if (hours === '') {
    start = 0;
    end = DAY_MINUTES - 1;
  } else {
    if (hours.length < 4 || !isDigit(hours[0])) return;
    start = 600 * digitValue(hours[0]) + 60 * digitValue(hours[1]) + leadingInteger(hours.slice(2));
    if (end < 0) end = start;
  }
  if (end < 0) end = 0;
  if (start < 0) start = 0;
  if (end >= DAY_MINUTES) end = DAY_MINUTES - 1;
  if (start >= DAY_MINUTES) start = DAY_MINUTES - 1;
  let minute = start;
  for (;;) {
    week[dayOffsetMinutes + minute] = 1;
    if (minute === end) break;
    minute = (minute + 1) % DAY_MINUTES;
  }
}

function fillDays(week: Uint8Array, term: string): void {
  let hoursAt = 0;
  while (hoursAt < term.length && !isDigit(term[hoursAt])) hoursAt++;
  const hours = term.slice(hoursAt);
  const cursor = { rest: hoursAt === 0 ? 'Al' : term };
  for (;;) {
    let start = takeDayCode(cursor);
    if (start < 0) break;
    let end = start;
    if (cursor.rest.startsWith('-')) {
      cursor.rest = cursor.rest.slice(1);
      end = takeDayCode(cursor);
      if (end < 0) break;
    }
    if (start === 7) { start = 1; end = 5; }
    if (start > 7) { start = 0; end = 6; }
    let day = start;
    for (;;) {
      fillHours(week, day * DAY_MINUTES, hours);
      if (day === end) break;
      day = (day + 1) % 7;
    }
  }
}

export function loginTimeSecondsLeft(specification: string, minuteOfWeek: number): number {
  const week = new Uint8Array(WEEK_MINUTES);
  for (const term of specification.toLowerCase().split(/[,|]/)) {
    if (term !== '') fillDays(week, term);
  }
  let total = 0;
  let minute = minuteOfWeek;
  for (;;) {
    if (week[minute] === 0) break;
    total += 60;
    minute = (minute + 1) % WEEK_MINUTES;
    if (minute === minuteOfWeek) break;
  }
  if (total === 0) return -1;
  return minute === minuteOfWeek ? 0 : total;
}
