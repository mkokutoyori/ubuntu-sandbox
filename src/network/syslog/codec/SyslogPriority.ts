export const LOG_MAX_PRI = 191;
export const LOG_FACILITY_INVALID = 24;
export const LOG_INVALID = LOG_FACILITY_INVALID << 3;
export const LOG_PRI_INVALID = LOG_INVALID | 7;
export const DEFAULT_PRI = (1 << 3) | 5;

export const FACILITY_TEXT: readonly string[] = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp',
  'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock', 'local0', 'local1',
  'local2', 'local3', 'local4', 'local5', 'local6', 'local7', 'invld',
];

export const SEVERITY_TEXT: readonly string[] = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

const FACILITY_BY_NAME: Readonly<Record<string, number>> = {
  auth: 4, authpriv: 10, cron: 9, daemon: 3, kern: 0, lpr: 6, mail: 2, mark: 24, news: 7, ntp: 12, security: 4,
  bsd_security: 13, syslog: 5, user: 1, uucp: 8, ftp: 11, audit: 13, console: 14, local0: 16, local1: 17, local2: 18,
  local3: 19, local4: 20, local5: 21, local6: 22, local7: 23, invld: 24,
};

const SEVERITY_BY_NAME: Readonly<Record<string, number>> = {
  alert: 1, crit: 2, debug: 7, emerg: 0, err: 3, error: 3, info: 6, notice: 5, panic: 0, warn: 4, warning: 4,
};

export function facilityNumber(name: string): number | null {
  return FACILITY_BY_NAME[name.toLowerCase()] ?? null;
}

export function severityNumber(name: string): number | null {
  return SEVERITY_BY_NAME[name.toLowerCase()] ?? null;
}

export function facilityOf(pri: number): number {
  return pri >> 3;
}

export function severityOf(pri: number): number {
  return pri & 7;
}

export function priorityValue(facility: number, severity: number): number {
  return facility * 8 + severity;
}

export function normalizePri(pri: number): number {
  return pri > LOG_MAX_PRI ? LOG_PRI_INVALID : pri;
}

export interface ParsedPri {
  readonly pri: number;
  readonly offset: number;
}

export function parsePri(raw: string): ParsedPri | null {
  if (raw.length < 3 || raw[0] !== '<') return null;
  const digit = (index: number): boolean => raw[index] !== undefined && raw[index] >= '0' && raw[index] <= '9';
  if (digit(1) && raw[2] === '>') return { pri: Number(raw[1]), offset: 3 };
  if (raw.length >= 4 && digit(1) && digit(2) && raw[3] === '>') return { pri: Number(raw.slice(1, 3)), offset: 4 };
  if (raw.length >= 5 && digit(1) && digit(2) && digit(3) && raw[4] === '>') {
    const value = Number(raw.slice(1, 4));
    if (value <= LOG_MAX_PRI) return { pri: value, offset: 5 };
  }
  return null;
}
