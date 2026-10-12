import { abreviationA, decalageA } from '../time/TimezoneDatabase';

export interface BrokenDownTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  isDst: number;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (value: number, width = 2, fill = '0'): string => String(value).padStart(width, fill);

export class LocalCalendar {
  constructor(private readonly zone: string | undefined) {}

  private offsetSeconds(epochSeconds: number): number {
    return this.zone === undefined ? 0 : decalageA(this.zone, epochSeconds * 1000) * 60;
  }

  localtime(epochSeconds: number): BrokenDownTime {
    const shifted = new Date((epochSeconds + this.offsetSeconds(epochSeconds)) * 1000);
    const standard = this.zone === undefined ? 0 : Math.min(
      decalageA(this.zone, Date.UTC(shifted.getUTCFullYear(), 0, 1)),
      decalageA(this.zone, Date.UTC(shifted.getUTCFullYear(), 6, 1)),
    );
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth(),
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      weekday: shifted.getUTCDay(),
      isDst: this.zone !== undefined && decalageA(this.zone, epochSeconds * 1000) > standard ? 1 : 0,
    };
  }

  mktime(fields: Pick<BrokenDownTime, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>): number {
    const wall = Date.UTC(fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second) / 1000;
    let guess = wall - this.offsetSeconds(wall);
    guess = wall - this.offsetSeconds(guess);
    return guess;
  }

  normalise(fields: Pick<BrokenDownTime, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>): BrokenDownTime {
    return this.localtime(this.mktime(fields));
  }

  abbreviation(epochSeconds: number): string {
    return this.zone === undefined ? 'UTC' : abreviationA(this.zone, epochSeconds * 1000);
  }

  offsetLabel(epochSeconds: number): string {
    const minutes = this.offsetSeconds(epochSeconds) / 60;
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(minutes);
    return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  }

  strftime(format: string, time: BrokenDownTime): string {
    const epoch = this.mktime(time);
    let out = '';
    for (let i = 0; i < format.length; i++) {
      const char = format[i];
      if (char !== '%' || i + 1 >= format.length) {
        out += char;
        continue;
      }
      i++;
      out += this.conversion(format[i], time, epoch);
    }
    return out;
  }

  private conversion(spec: string, time: BrokenDownTime, epoch: number): string {
    switch (spec) {
      case 'Y': return String(time.year);
      case 'y': return pad(time.year % 100);
      case 'C': return pad(Math.floor(time.year / 100));
      case 'm': return pad(time.month + 1);
      case 'd': return pad(time.day);
      case 'e': return pad(time.day, 2, ' ');
      case 'H': return pad(time.hour);
      case 'I': return pad(time.hour % 12 === 0 ? 12 : time.hour % 12);
      case 'M': return pad(time.minute);
      case 'S': return pad(time.second);
      case 'p': return time.hour < 12 ? 'AM' : 'PM';
      case 's': return String(epoch);
      case 'j': return pad(dayOfYear(time), 3);
      case 'a': return WEEKDAYS[time.weekday].slice(0, 3);
      case 'A': return WEEKDAYS[time.weekday];
      case 'b': case 'h': return MONTHS[time.month].slice(0, 3);
      case 'B': return MONTHS[time.month];
      case 'u': return String(time.weekday === 0 ? 7 : time.weekday);
      case 'w': return String(time.weekday);
      case 'V': return pad(isoWeek(time).week);
      case 'G': return String(isoWeek(time).year);
      case 'g': return pad(isoWeek(time).year % 100);
      case 'U': return pad(Math.floor((dayOfYear(time) - 1 + 7 - time.weekday) / 7));
      case 'W': return pad(Math.floor((dayOfYear(time) - 1 + 7 - ((time.weekday + 6) % 7)) / 7));
      case 'Z': return this.abbreviation(epoch);
      case 'z': return this.offsetLabel(epoch);
      case 'F': return `${time.year}-${pad(time.month + 1)}-${pad(time.day)}`;
      case 'T': return `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
      case 'R': return `${pad(time.hour)}:${pad(time.minute)}`;
      case 'D': return `${pad(time.month + 1)}/${pad(time.day)}/${pad(time.year % 100)}`;
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return `%${spec}`;
    }
  }
}

function dayOfYear(time: BrokenDownTime): number {
  return Math.round((Date.UTC(time.year, time.month, time.day) - Date.UTC(time.year, 0, 1)) / 86400000) + 1;
}

function isoWeek(time: BrokenDownTime): { year: number; week: number } {
  const date = new Date(Date.UTC(time.year, time.month, time.day));
  const dayNumber = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: date.getUTCFullYear(), week };
}

export function strptimeFields(text: string, format: string): Partial<BrokenDownTime> | null {
  const fields: Partial<BrokenDownTime> = {};
  let position = 0;
  const number = (digits: number): number | null => {
    const slice = text.slice(position, position + digits);
    if (!/^\d+$/.test(slice)) return null;
    position += slice.length;
    return Number(slice);
  };
  for (let i = 0; i < format.length; i++) {
    const char = format[i];
    if (char !== '%') {
      if (text[position] !== char) return null;
      position++;
      continue;
    }
    i++;
    const spec = format[i];
    const parsed = spec === 'Y' ? number(4) : spec === '%' ? 0 : number(2);
    if (parsed === null) return null;
    switch (spec) {
      case 'Y': fields.year = parsed; break;
      case 'y': fields.year = parsed < 69 ? 2000 + parsed : 1900 + parsed; break;
      case 'm': fields.month = parsed - 1; break;
      case 'd': fields.day = parsed; break;
      case 'H': fields.hour = parsed; break;
      case 'M': fields.minute = parsed; break;
      case 'S': fields.second = parsed; break;
      default: break;
    }
  }
  return fields;
}
