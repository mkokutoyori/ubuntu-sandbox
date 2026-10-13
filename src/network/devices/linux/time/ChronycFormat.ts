export class ReportTime {
  constructor(readonly epochSeconds: number, readonly nanoseconds?: number) {}
}

export type ReportValue = number | string | ReportTime;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNSET_INTERVAL = 4294967295;

function fixed(value: number, precision: number): string {
  const negative = value < 0 || Object.is(value, -0);
  return `${negative ? '-' : ''}${Math.abs(value).toFixed(precision)}`;
}

function signedFixed(value: number, precision: number): string {
  const negative = value < 0 || Object.is(value, -0);
  return `${negative ? '-' : '+'}${Math.abs(value).toFixed(precision)}`;
}

function pad(text: string, width: number): string {
  return text.padStart(width);
}

export function formatSeconds(value: number): string {
  if (value === UNSET_INTERVAL || value === -1) return '   -';
  if (value < 1200) return pad(String(value), 4);
  if (value < 36000) return `${pad(String(Math.floor(value / 60)), 3)}m`;
  if (value < 345600) return `${pad(String(Math.floor(value / 3600)), 3)}h`;
  const days = Math.floor(value / 86400);
  return days > 999 ? `${pad(String(Math.floor(days / 365)), 3)}y` : `${pad(String(days), 3)}d`;
}

export function formatNanoseconds(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 9999.5e-9) return `${pad(fixed(s * 1e9, 0), 4)}ns`;
  if (s < 9999.5e-6) return `${pad(fixed(s * 1e6, 0), 4)}us`;
  if (s < 9999.5e-3) return `${pad(fixed(s * 1e3, 0), 4)}ms`;
  if (s < 999.5) return `${pad(fixed(s, 1), 5)}s`;
  if (s < 99999.5) return `${pad(fixed(s, 0), 5)}s`;
  if (s < 99999.5 * 60) return `${pad(fixed(s / 60, 0), 5)}m`;
  if (s < 99999.5 * 3600) return `${pad(fixed(s / 3600, 0), 5)}h`;
  if (s < 99999.5 * 3600 * 24) return `${pad(fixed(s / (3600 * 24), 0), 5)}d`;
  return `${pad(fixed(s / (3600 * 24 * 365), 0), 5)}y`;
}

export function formatSignedNanoseconds(seconds: number): string {
  const x = Math.abs(seconds);
  if (x < 9999.5e-9) return `${pad(signedFixed(seconds * 1e9, 0), 5)}ns`;
  if (x < 9999.5e-6) return `${pad(signedFixed(seconds * 1e6, 0), 5)}us`;
  if (x < 9999.5e-3) return `${pad(signedFixed(seconds * 1e3, 0), 5)}ms`;
  if (x < 999.5) return `${pad(signedFixed(seconds, 1), 6)}s`;
  if (x < 99999.5) return `${pad(signedFixed(seconds, 0), 6)}s`;
  if (x < 99999.5 * 60) return `${pad(signedFixed(seconds / 60, 0), 6)}m`;
  if (x < 99999.5 * 3600) return `${pad(signedFixed(seconds / 3600, 0), 6)}h`;
  if (x < 99999.5 * 3600 * 24) return `${pad(signedFixed(seconds / (3600 * 24), 0), 6)}d`;
  return `${pad(signedFixed(seconds / (3600 * 24 * 365), 0), 6)}y`;
}

function formatFrequency(value: number): string {
  return pad(Math.abs(value) < 99999.5 ? fixed(value, 3) : fixed(value, 0), 10);
}

function formatSignedFrequency(value: number): string {
  return pad(Math.abs(value) < 99999.5 ? signedFixed(value, 3) : signedFixed(value, 0), 10);
}

function formatInterval(rate: number): string {
  return rate >= 127 ? ' -' : pad(String(rate), 2);
}

function formatLeap(value: number, short: boolean): string {
  switch (value) {
    case 0: return short ? 'N' : 'Normal';
    case 1: return short ? '+' : 'Insert second';
    case 2: return short ? '-' : 'Delete second';
    case 3: return short ? '?' : 'Not synchronised';
    default: return short ? '?' : 'Invalid';
  }
}

function formatMode(value: number): string {
  switch (value) {
    case 1: return 'Symmetric active';
    case 2: return 'Symmetric passive';
    case 4: return 'Server';
    default: return 'Invalid';
  }
}

function formatTimestampSource(value: ReportValue): string {
  switch (typeof value === 'number' ? String.fromCharCode(value) : value) {
    case 'D': return 'Daemon';
    case 'K': return 'Kernel';
    case 'H': return 'Hardware';
    default: return 'Invalid';
  }
}

function dateText(time: ReportTime): string {
  const date = new Date(Math.floor(time.epochSeconds) * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${two(date.getUTCDate())} `
    + `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

function epochText(time: ReportTime): string {
  const seconds = Math.floor(time.epochSeconds);
  const nanoseconds = time.nanoseconds ?? Math.round((time.epochSeconds - seconds) * 1e9);
  return `${seconds}.${String(nanoseconds).padStart(9, '0')}`;
}

function asNumber(value: ReportValue): number {
  return typeof value === 'number' ? value : Number(value);
}

export function printReport(template: string, values: readonly ReportValue[], csv: boolean): string {
  let out = '';
  let rest = template;
  let field = 0;
  let valueIndex = 0;
  for (;;) {
    const percent = rest.indexOf('%');
    const literal = percent < 0 ? rest : rest.slice(0, percent);
    if (!csv) out += literal;
    if (percent < 0 || percent + 1 >= rest.length) break;
    rest = rest.slice(percent + 1);
    let sign = false;
    let width = 0;
    let precision = 5;
    let position = 0;
    if (rest[position] === '+' || rest[position] === '-') { sign = true; position++; }
    const widthMatch = /^\d+/.exec(rest.slice(position));
    if (widthMatch) { width = Number(widthMatch[0]); position += widthMatch[0].length; }
    if (rest[position] === '.') {
      position++;
      const precisionMatch = /^\d+/.exec(rest.slice(position));
      if (precisionMatch) { precision = Number(precisionMatch[0]); position += precisionMatch[0].length; }
    }
    let spec = rest[position];
    rest = rest.slice(position + 1);
    if (csv) {
      sign = false;
      width = 0;
      if (field > 0) out += ',';
      if (spec === 'C') spec = 'd';
      else if (spec === 'F' || spec === 'P') { precision = 3; spec = 'f'; }
      else if (spec === 'O' || spec === 'S') { precision = 9; spec = 'f'; }
      else if (spec === 'I') spec = 'U';
      else if (spec === 'T') spec = 'V';
    }
    const value = values[valueIndex++];
    switch (spec) {
      case 'B': out += asNumber(value) ? 'Yes' : 'No'; break;
      case 'C': out += formatInterval(asNumber(value)); break;
      case 'F':
      case 'O': {
        const number = asNumber(value);
        const slow = ((number > 0) ? 1 : 0) ^ (spec !== 'O' ? 1 : 0);
        out += `${pad(fixed(Math.abs(number), precision), width)} ${spec === 'O' ? 'seconds' : 'ppm'} ${slow ? 'slow' : 'fast'}`;
        break;
      }
      case 'I': out += formatSeconds(asNumber(value)); break;
      case 'L': out += formatLeap(asNumber(value), width === 1); break;
      case 'M': out += formatMode(asNumber(value)); break;
      case 'N': out += formatTimestampSource(value); break;
      case 'P': out += sign ? formatSignedFrequency(asNumber(value)) : formatFrequency(asNumber(value)); break;
      case 'R': out += (asNumber(value) >>> 0).toString(16).toUpperCase().padStart(8, '0'); break;
      case 'S': out += sign ? formatSignedNanoseconds(asNumber(value)) : formatNanoseconds(asNumber(value)); break;
      case 'T': out += dateText(value as ReportTime); break;
      case 'U':
      case 'Q':
      case 'u': out += pad(String(asNumber(value)), width); break;
      case 'V': out += epochText(value as ReportTime); break;
      case 'b': out += asNumber(value).toString(2).padStart(precision, '0').slice(-precision); break;
      case 'c': out += String(value); break;
      case 'd': out += pad(String(asNumber(value)), width); break;
      case 'f': out += pad(sign ? signedFixed(asNumber(value), precision) : fixed(asNumber(value), precision), width); break;
      case 'o': out += pad(asNumber(value).toString(8), width); break;
      case 's': out += sign ? String(value).padEnd(width) : String(value).padStart(width); break;
      default: break;
    }
    field++;
  }
  return csv ? `${out}\n` : out;
}

export function printHeader(header: string, csv: boolean): string {
  return csv ? '' : `${header}\n${'='.repeat(header.length)}\n`;
}
