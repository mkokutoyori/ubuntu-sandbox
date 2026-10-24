import { parseBoolean, readSystemdConfig, type ConfigAssignment, type ConfigSource, type ConfigSpec } from '../systemd/ConfigFiles';
import { parseTimeSpan } from '../systemd/TimeSpan';
import { DEFAULT_JOURNALD_SETTINGS, type JournaldSettings, type JournaldStorage } from './JournaldServer';

export const JOURNALD_CONFIG_SPEC: ConfigSpec = {
  mainFile: '/etc/systemd/journald.conf',
  dropInName: 'journald.conf.d',
  sections: {
    Journal: [
      'Storage', 'Compress', 'Seal', 'SplitMode', 'RateLimitInterval', 'RateLimitIntervalSec', 'RateLimitBurst',
      'SystemMaxUse', 'SystemKeepFree', 'SystemMaxFileSize', 'SystemMaxFiles',
      'RuntimeMaxUse', 'RuntimeKeepFree', 'RuntimeMaxFileSize', 'RuntimeMaxFiles',
      'MaxRetentionSec', 'MaxFileSec', 'SyncIntervalSec',
      'ForwardToSyslog', 'ForwardToKMsg', 'ForwardToConsole', 'ForwardToWall', 'TTYPath',
      'MaxLevelStore', 'MaxLevelSyslog', 'MaxLevelKMsg', 'MaxLevelConsole', 'MaxLevelWall',
      'LineMax', 'ReadKMsg', 'Audit',
    ],
  },
};

const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const STORAGE_VALUES: readonly JournaldStorage[] = ['volatile', 'persistent', 'auto', 'none'];
const SPLIT_MODES = ['login', 'uid', 'none'];
const SIZE_UNITS: Readonly<Record<string, number>> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 };
const LINE_MAX_FLOOR = 79;

export function parseLogLevel(text: string): number | null {
  if (/^[0-7]$/.test(text)) return Number(text);
  const index = LOG_LEVELS.indexOf(text);
  return index >= 0 ? index : null;
}

export function parseSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([BKMGTPE]?)$/.exec(text);
  if (match === null) return null;
  return Math.floor(Number(match[1]) * SIZE_UNITS[match[2] === '' ? 'B' : match[2]]);
}

type Setter = (settings: JournaldSettings, value: string, assignment: ConfigAssignment) => string | null;

const level = (apply: (settings: JournaldSettings, level: number) => void): Setter => (settings, value) => {
  const parsed = parseLogLevel(value);
  if (parsed === null) return `Failed to parse log level, ignoring: ${value}`;
  apply(settings, parsed);
  return null;
};

const forward = (apply: (settings: JournaldSettings, enabled: boolean) => void): Setter => (settings, value, assignment) => {
  const parsed = parseBoolean(value);
  if (parsed === null) return `Failed to parse boolean value for ${assignment.key}=, ignoring: ${value}`;
  apply(settings, parsed);
  return null;
};

const validated = (check: (value: string) => boolean, message: (value: string, key: string) => string): Setter => (_settings, value, assignment) =>
  check(value) ? null : message(value, assignment.key);

const isSeconds = (value: string): boolean => value === 'infinity' || parseTimeSpan(value) !== undefined;
const isSize = (value: string): boolean => value === 'infinity' || parseSize(value) !== null;
const isBoolean = (value: string): boolean => parseBoolean(value) !== null;

const SETTERS: Readonly<Record<string, Setter>> = {
  Storage: (settings, value) => {
    if (!(STORAGE_VALUES as readonly string[]).includes(value)) return `Failed to parse storage setting, ignoring: ${value}`;
    settings.storage = value as JournaldStorage;
    return null;
  },
  MaxLevelStore: level((settings, parsed) => { settings.maxLevelStore = parsed; }),
  MaxLevelSyslog: level((settings, parsed) => { settings.maxLevelSyslog = parsed; }),
  MaxLevelKMsg: level((settings, parsed) => { settings.maxLevelKmsg = parsed; }),
  MaxLevelConsole: level((settings, parsed) => { settings.maxLevelConsole = parsed; }),
  MaxLevelWall: level((settings, parsed) => { settings.maxLevelWall = parsed; }),
  ForwardToSyslog: forward((settings, enabled) => { settings.forwardToSyslog = enabled; }),
  ForwardToKMsg: forward((settings, enabled) => { settings.forwardToKmsg = enabled; }),
  ForwardToConsole: forward((settings, enabled) => { settings.forwardToConsole = enabled; }),
  ForwardToWall: forward((settings, enabled) => { settings.forwardToWall = enabled; }),
  LineMax: (settings, value) => {
    const parsed = parseSize(value);
    if (parsed === null) return `Failed to parse LineMax= value, ignoring: ${value}`;
    settings.lineMax = Math.max(parsed, LINE_MAX_FLOOR);
    return null;
  },
  Compress: validated((value) => isBoolean(value) || parseSize(value) !== null, (value) => `Failed to parse Compress= value, ignoring: ${value}`),
  SplitMode: validated((value) => SPLIT_MODES.includes(value), (value) => `Failed to parse split mode setting, ignoring: ${value}`),
  Seal: validated(isBoolean, (value, key) => `Failed to parse boolean value for ${key}=, ignoring: ${value}`),
  ReadKMsg: validated(isBoolean, (value, key) => `Failed to parse boolean value for ${key}=, ignoring: ${value}`),
  Audit: validated(isBoolean, (value, key) => `Failed to parse boolean value for ${key}=, ignoring: ${value}`),
  RateLimitInterval: validated(isSeconds, (value) => `Failed to parse time value, ignoring: ${value}`),
  RateLimitIntervalSec: validated(isSeconds, (value) => `Failed to parse time value, ignoring: ${value}`),
  SyncIntervalSec: validated(isSeconds, (value) => `Failed to parse time value, ignoring: ${value}`),
  MaxRetentionSec: validated(isSeconds, (value) => `Failed to parse time value, ignoring: ${value}`),
  MaxFileSec: validated(isSeconds, (value) => `Failed to parse time value, ignoring: ${value}`),
  RateLimitBurst: validated((value) => /^\d+$/.test(value), (value) => `Failed to parse unsigned value, ignoring: ${value}`),
  SystemMaxFiles: validated((value) => /^\d+$/.test(value), (value) => `Failed to parse unsigned value, ignoring: ${value}`),
  RuntimeMaxFiles: validated((value) => /^\d+$/.test(value), (value) => `Failed to parse unsigned value, ignoring: ${value}`),
  SystemMaxUse: validated(isSize, (value) => `Failed to parse size value, ignoring: ${value}`),
  SystemKeepFree: validated(isSize, (value) => `Failed to parse size value, ignoring: ${value}`),
  SystemMaxFileSize: validated(isSize, (value) => `Failed to parse size value, ignoring: ${value}`),
  RuntimeMaxUse: validated(isSize, (value) => `Failed to parse size value, ignoring: ${value}`),
  RuntimeKeepFree: validated(isSize, (value) => `Failed to parse size value, ignoring: ${value}`),
  RuntimeMaxFileSize: validated(isSize, (value) => `Failed to parse size value, ignoring: ${value}`),
};

const EVALUATED_FIELDS: Readonly<Record<string, keyof JournaldSettings>> = {
  Storage: 'storage', MaxLevelStore: 'maxLevelStore', MaxLevelSyslog: 'maxLevelSyslog', MaxLevelKMsg: 'maxLevelKmsg',
  MaxLevelConsole: 'maxLevelConsole', MaxLevelWall: 'maxLevelWall', ForwardToSyslog: 'forwardToSyslog', ForwardToKMsg: 'forwardToKmsg',
  ForwardToConsole: 'forwardToConsole', ForwardToWall: 'forwardToWall', LineMax: 'lineMax',
};

function restoreDefault(settings: JournaldSettings, key: string): void {
  const field = EVALUATED_FIELDS[key];
  if (field !== undefined) (settings as unknown as Record<string, unknown>)[field] = DEFAULT_JOURNALD_SETTINGS[field];
}

export interface JournaldConfigReadout {
  readonly settings: JournaldSettings;
  readonly diagnostics: string[];
}

export function readJournaldConfig(source: ConfigSource): JournaldConfigReadout {
  const readout = readSystemdConfig(source, JOURNALD_CONFIG_SPEC);
  const settings: JournaldSettings = { ...DEFAULT_JOURNALD_SETTINGS };
  const diagnostics = [...readout.diagnostics];
  for (const assignment of readout.assignments) {
    const setter = SETTERS[assignment.key];
    if (setter === undefined) continue;
    if (assignment.value === '') {
      restoreDefault(settings, assignment.key);
      continue;
    }
    const complaint = setter(settings, assignment.value, assignment);
    if (complaint !== null) diagnostics.push(`${assignment.file}:${assignment.line}: ${complaint}`);
  }
  return { settings, diagnostics };
}
