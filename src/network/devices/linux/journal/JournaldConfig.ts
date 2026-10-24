import {
  absolutePathHandler, booleanHandler, enumHandler, iecUint64Handler, readSystemdConfig, secHandler, tristateHandler, uint64Handler, unsignedHandler,
  parseBoolean, type ConfigDiagnostic, type ConfigHandler, type ConfigSource, type ConfigSpec,
} from '../systemd/ConfigFiles';
import { parseSize } from '../systemd/ParseSize';
import {
  defaultJournaldSettings, type JournalMetrics, type JournaldSettings, type JournaldSplitMode, type JournaldStorage,
} from './JournaldServer';

const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const STORAGE_VALUES: readonly JournaldStorage[] = ['auto', 'volatile', 'persistent', 'none'];
const SPLIT_MODES: readonly JournaldSplitMode[] = ['login', 'uid', 'none'];
const LINE_MAX_FLOOR = 79;
const DEFAULT_LINE_MAX = 48 * 1024;
const LOG_WARNING = 4;

export function parseLogLevel(text: string): number | null {
  if (/^[0-7]$/.test(text)) return Number(text);
  const index = LOG_LEVELS.indexOf(text);
  return index >= 0 ? index : null;
}

export const JOURNALD_CONFIG_FILE = '/etc/systemd/journald.conf';

function logLevelHandler(apply: (level: number) => void): ConfigHandler {
  return (value, _at, warn) => {
    const parsed = parseLogLevel(value);
    if (parsed === null) warn(`Failed to parse log level, ignoring: ${value}`);
    else apply(parsed);
  };
}

function metricsHandlers(prefix: 'System' | 'Runtime', metrics: JournalMetrics): Array<[string, ConfigHandler]> {
  return [
    [`Journal.${prefix}MaxUse`, iecUint64Handler((bytes) => { metrics.maxUse = bytes; })],
    [`Journal.${prefix}MaxFileSize`, iecUint64Handler((bytes) => { metrics.maxSize = bytes; })],
    [`Journal.${prefix}KeepFree`, iecUint64Handler((bytes) => { metrics.keepFree = bytes; })],
    [`Journal.${prefix}MaxFiles`, uint64Handler((count) => { metrics.maxFiles = count; })],
  ];
}

function lineMaxHandler(settings: JournaldSettings): ConfigHandler {
  return (value, _at, warn) => {
    if (value === '') {
      settings.lineMax = DEFAULT_LINE_MAX;
      return;
    }
    const parsed = parseSize(value, 1024);
    if (parsed === null) warn(`Failed to parse LineMax= value, ignoring: ${value}`);
    else if (parsed < LINE_MAX_FLOOR) {
      warn(`LineMax= too small, clamping to ${LINE_MAX_FLOOR}: ${value}`);
      settings.lineMax = LINE_MAX_FLOOR;
    } else settings.lineMax = parsed;
  };
}

function compressHandler(settings: JournaldSettings): ConfigHandler {
  return (value, _at, warn) => {
    if (value === '') {
      settings.compress = { enabled: true, thresholdBytes: null };
    } else if (value === '1') {
      warn('Compress= ambiguously specified as 1, enabling compression with default threshold');
      settings.compress.enabled = true;
    } else if (value === '0') {
      warn('Compress= ambiguously specified as 0, disabling compression');
      settings.compress.enabled = false;
    } else {
      const flag = parseBoolean(value);
      if (flag !== null) {
        settings.compress.enabled = flag;
        return;
      }
      const threshold = parseSize(value, 1024);
      if (threshold === null) warn(`Failed to parse Compress= value, ignoring: ${value}`);
      else settings.compress = { enabled: true, thresholdBytes: threshold };
    }
  };
}

function journaldSpec(settings: JournaldSettings): ConfigSpec {
  const secInto = (apply: (usec: number) => void): ConfigHandler => secHandler(apply);
  const handlers = new Map<string, ConfigHandler>([
    ['Journal.Storage', enumHandler(STORAGE_VALUES, 'Failed to parse storage setting', (value) => { settings.storage = value; })],
    ['Journal.Compress', compressHandler(settings)],
    ['Journal.Seal', booleanHandler((value) => { settings.seal = value; })],
    ['Journal.ReadKMsg', booleanHandler((value) => { settings.readKmsg = value; })],
    ['Journal.Audit', tristateHandler((value) => { settings.setAudit = value; })],
    ['Journal.SyncIntervalSec', secInto((usec) => { settings.syncIntervalUsec = usec; })],
    ['Journal.RateLimitInterval', secInto((usec) => { settings.rateLimitIntervalUsec = usec; })],
    ['Journal.RateLimitIntervalSec', secInto((usec) => { settings.rateLimitIntervalUsec = usec; })],
    ['Journal.RateLimitBurst', unsignedHandler((count) => { settings.rateLimitBurst = count; })],
    ...metricsHandlers('System', settings.systemMetrics),
    ...metricsHandlers('Runtime', settings.runtimeMetrics),
    ['Journal.MaxRetentionSec', secInto((usec) => { settings.maxRetentionUsec = usec; })],
    ['Journal.MaxFileSec', secInto((usec) => { settings.maxFileUsec = usec; })],
    ['Journal.ForwardToSyslog', booleanHandler((value) => { settings.forwardToSyslog = value; })],
    ['Journal.ForwardToKMsg', booleanHandler((value) => { settings.forwardToKmsg = value; })],
    ['Journal.ForwardToConsole', booleanHandler((value) => { settings.forwardToConsole = value; })],
    ['Journal.ForwardToWall', booleanHandler((value) => { settings.forwardToWall = value; })],
    ['Journal.TTYPath', absolutePathHandler((path) => { settings.ttyPath = path; })],
    ['Journal.MaxLevelStore', logLevelHandler((level) => { settings.maxLevelStore = level; })],
    ['Journal.MaxLevelSyslog', logLevelHandler((level) => { settings.maxLevelSyslog = level; })],
    ['Journal.MaxLevelKMsg', logLevelHandler((level) => { settings.maxLevelKmsg = level; })],
    ['Journal.MaxLevelConsole', logLevelHandler((level) => { settings.maxLevelConsole = level; })],
    ['Journal.MaxLevelWall', logLevelHandler((level) => { settings.maxLevelWall = level; })],
    ['Journal.SplitMode', enumHandler(SPLIT_MODES, 'Failed to parse split mode setting', (value) => { settings.splitMode = value; })],
    ['Journal.LineMax', lineMaxHandler(settings)],
  ]);
  return { mainFile: JOURNALD_CONFIG_FILE, dropInName: 'journald.conf.d', sections: ['Journal'], handlers };
}

const KERNEL_SWITCHES: ReadonlyArray<readonly [string, string, (settings: JournaldSettings, value: boolean) => void]> = [
  ['forward_to_syslog', 'syslog', (settings, value) => { settings.forwardToSyslog = value; }],
  ['forward_to_kmsg', 'kmsg', (settings, value) => { settings.forwardToKmsg = value; }],
  ['forward_to_console', 'console', (settings, value) => { settings.forwardToConsole = value; }],
  ['forward_to_wall', 'wall', (settings, value) => { settings.forwardToWall = value; }],
];

const KERNEL_LEVELS: ReadonlyArray<readonly [string, string, (settings: JournaldSettings, level: number) => void]> = [
  ['max_level_console', 'console', (settings, level) => { settings.maxLevelConsole = level; }],
  ['max_level_store', 'store', (settings, level) => { settings.maxLevelStore = level; }],
  ['max_level_syslog', 'syslog', (settings, level) => { settings.maxLevelSyslog = level; }],
  ['max_level_kmsg', 'kmsg', (settings, level) => { settings.maxLevelKmsg = level; }],
  ['max_level_wall', 'wall', (settings, level) => { settings.maxLevelWall = level; }],
];

function cmdlineWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of text.trim()) {
    if (character === '"') quoted = !quoted;
    else if (/\s/.test(character) && !quoted) {
      if (current !== '') words.push(current);
      current = '';
    } else current += character;
  }
  if (current !== '') words.push(current);
  return words;
}

const sameKey = (key: string, name: string): boolean => key.replace(/-/g, '_') === `systemd.journald.${name}`;

function applyKernelCommandLine(commandLine: string, settings: JournaldSettings, warn: (message: string) => void): void {
  for (const word of cmdlineWords(commandLine)) {
    const equals = word.indexOf('=');
    const key = equals < 0 ? word : word.slice(0, equals);
    const value = equals < 0 ? null : word.slice(equals + 1);
    if (!key.startsWith('systemd.journald')) continue;
    const switchEntry = KERNEL_SWITCHES.find(([name]) => sameKey(key, name));
    const levelEntry = KERNEL_LEVELS.find(([name]) => sameKey(key, name));
    if (switchEntry !== undefined) {
      const parsed = value === null ? true : parseBoolean(value);
      if (parsed === null) warn(`Failed to parse forward to ${switchEntry[1]} switch "${value}". Ignoring.`);
      else switchEntry[2](settings, parsed);
    } else if (levelEntry !== undefined) {
      if (value === null) continue;
      const level = parseLogLevel(value);
      if (level === null) warn(`Failed to parse max level ${levelEntry[1]} value "${value}". Ignoring.`);
      else levelEntry[2](settings, level);
    } else {
      warn(`Unknown journald kernel command line option "${key}". Ignoring.`);
    }
  }
}

export interface JournaldConfigReadout {
  readonly settings: JournaldSettings;
  readonly diagnostics: ConfigDiagnostic[];
}

export function readJournaldConfig(source: ConfigSource, kernelCommandLine: string = ''): JournaldConfigReadout {
  const settings = defaultJournaldSettings();
  const diagnostics = readSystemdConfig(source, journaldSpec(settings));
  applyKernelCommandLine(kernelCommandLine, settings, (message) => diagnostics.push({ priority: LOG_WARNING, file: '', line: 0, message }));
  if ((settings.rateLimitIntervalUsec !== 0) !== (settings.rateLimitBurst !== 0)) {
    settings.rateLimitIntervalUsec = 0;
    settings.rateLimitBurst = 0;
  }
  return { settings, diagnostics };
}
