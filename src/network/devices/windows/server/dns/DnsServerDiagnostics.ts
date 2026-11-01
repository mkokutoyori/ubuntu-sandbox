import { IPAddress } from '@/network/core/types';
import { joinMultiString, splitMultiString, type DnsServerParameters } from './DnsServerParameters';

export type DnsDiagnosticsKind = 'flag' | 'count' | 'text' | 'addresses';

export type DnsDiagnosticsValue = boolean | number | string | readonly string[];

export interface DnsDiagnosticsEntry {
  readonly property: string;
  readonly kind: DnsDiagnosticsKind;
  readonly value: DnsDiagnosticsValue;
}

export const LOG_LEVEL = {
  queries: 0x1,
  notifications: 0x10,
  updates: 0x20,
  questions: 0x100,
  answers: 0x200,
  send: 0x1000,
  receive: 0x2000,
  udp: 0x4000,
  tcp: 0x8000,
  fullPackets: 0x01000000,
  unmatchedResponse: 0x02000000,
  writeThrough: 0x80000000,
} as const;

type LogWord = 'LogLevel' | 'OperationsLogLevel' | 'OperationsLogLevel2';

const DEFAULT_WORDS: Readonly<Record<LogWord, number>> = {
  LogLevel: 0,
  OperationsLogLevel: 0x10,
  OperationsLogLevel2: 0,
};

export const DEFAULT_EVENT_LOG_LEVEL = 4;
export const ALL_EVENTS_LOG_LEVEL = 7;
export const DEFAULT_LOG_FILE_MAX_BYTES = 500000000;

interface DiagnosticsSpec {
  readonly property: string;
  readonly kind: DnsDiagnosticsKind;
  readonly word: LogWord | null;
  readonly mask: number;
  readonly registry: string | null;
  readonly fallback: DnsDiagnosticsValue;
}

const bit = (property: string, word: LogWord, mask: number): DiagnosticsSpec =>
  ({ property, kind: 'flag', word, mask, registry: null, fallback: false });
const stored = (property: string, kind: DnsDiagnosticsKind, registry: string, fallback: DnsDiagnosticsValue): DiagnosticsSpec =>
  ({ property, kind, word: null, mask: 0, registry, fallback });

export const DIAGNOSTICS_PROPERTIES: readonly DiagnosticsSpec[] = [
  bit('SaveLogsToPersistentStorage', 'OperationsLogLevel', 0x1),
  bit('Queries', 'LogLevel', LOG_LEVEL.queries),
  bit('Answers', 'LogLevel', LOG_LEVEL.answers),
  bit('Notifications', 'LogLevel', LOG_LEVEL.notifications),
  bit('Update', 'LogLevel', LOG_LEVEL.updates),
  bit('QuestionTransactions', 'LogLevel', LOG_LEVEL.questions),
  bit('UnmatchedResponse', 'LogLevel', LOG_LEVEL.unmatchedResponse),
  bit('SendPackets', 'LogLevel', LOG_LEVEL.send),
  bit('ReceivePackets', 'LogLevel', LOG_LEVEL.receive),
  bit('TcpPackets', 'LogLevel', LOG_LEVEL.tcp),
  bit('UdpPackets', 'LogLevel', LOG_LEVEL.udp),
  bit('FullPackets', 'LogLevel', LOG_LEVEL.fullPackets),
  stored('FilterIPAddressList', 'addresses', 'LogIPFilterList', []),
  stored('EventLogLevel', 'count', 'EventLogLevel', DEFAULT_EVENT_LOG_LEVEL),
  stored('UseSystemEventLog', 'flag', 'UseSystemEventLog', false),
  bit('EnableLoggingToFile', 'OperationsLogLevel', 0x10),
  stored('EnableLogFileRollover', 'flag', 'EnableLogFileRollover', false),
  stored('LogFilePath', 'text', 'LogFilePath', ''),
  stored('MaxMBFileSize', 'count', 'LogFileMaxSize', DEFAULT_LOG_FILE_MAX_BYTES),
  bit('WriteThrough', 'LogLevel', LOG_LEVEL.writeThrough),
  bit('EnableLoggingForLocalLookupEvent', 'OperationsLogLevel', 0x100000),
  bit('EnableLoggingForPluginDllEvent', 'OperationsLogLevel2', 0x01000000),
  bit('EnableLoggingForRecursiveLookupEvent', 'OperationsLogLevel', 0x200000),
  bit('EnableLoggingForRemoteServerEvent', 'OperationsLogLevel', 0x400000),
  bit('EnableLoggingForServerStartStopEvent', 'OperationsLogLevel', 0x20),
  bit('EnableLoggingForTombstoneEvent', 'OperationsLogLevel', 0x20000),
  bit('EnableLoggingForZoneDataWriteEvent', 'OperationsLogLevel', 0x4000),
  bit('EnableLoggingForZoneLoadingEvent', 'OperationsLogLevel', 0x2000),
];

function readWord(parameters: DnsServerParameters, word: LogWord): number {
  return parameters.count(word, DEFAULT_WORDS[word]) >>> 0;
}

function readValue(spec: DiagnosticsSpec, parameters: DnsServerParameters): DnsDiagnosticsValue {
  if (spec.word !== null) return (readWord(parameters, spec.word) & spec.mask) !== 0;
  const registry = spec.registry as string;
  switch (spec.kind) {
    case 'flag': return parameters.flag(registry, spec.fallback as boolean);
    case 'count': return parameters.count(registry, spec.fallback as number);
    case 'text': return String(parameters.rawSetting(registry) ?? spec.fallback);
    case 'addresses': return splitMultiString(String(parameters.rawSetting(registry) ?? ''));
  }
}

export function readDiagnostics(parameters: DnsServerParameters): DnsDiagnosticsEntry[] {
  return DIAGNOSTICS_PROPERTIES.map(spec => ({ property: spec.property, kind: spec.kind, value: readValue(spec, parameters) }));
}

export interface DnsDiagnosticsChanges {
  readonly all?: boolean;
  readonly words?: Partial<Record<LogWord, number>>;
  readonly values?: ReadonlyMap<string, DnsDiagnosticsValue>;
}

const PARAMETER_ERROR = 'The parameter is incorrect.';

function plannedWords(parameters: DnsServerParameters, changes: DnsDiagnosticsChanges): Record<LogWord, number> {
  const words: Record<LogWord, number> = {
    LogLevel: readWord(parameters, 'LogLevel'),
    OperationsLogLevel: readWord(parameters, 'OperationsLogLevel'),
    OperationsLogLevel2: readWord(parameters, 'OperationsLogLevel2'),
  };
  for (const [word, value] of Object.entries(changes.words ?? {}) as Array<[LogWord, number]>) words[word] = value >>> 0;
  const apply = (spec: DiagnosticsSpec, on: boolean): void => {
    if (spec.word === null) return;
    words[spec.word] = (on ? words[spec.word] | spec.mask : words[spec.word] & ~spec.mask) >>> 0;
  };
  if (changes.all !== undefined) for (const spec of DIAGNOSTICS_PROPERTIES) apply(spec, changes.all);
  for (const [property, value] of changes.values ?? []) {
    const spec = DIAGNOSTICS_PROPERTIES.find(candidate => candidate.property.toLowerCase() === property.toLowerCase());
    if (spec !== undefined && spec.word !== null) apply(spec, value === true);
  }
  return words;
}

export function writeDiagnostics(parameters: DnsServerParameters, changes: DnsDiagnosticsChanges): string | null {
  const planned: Array<() => void> = [];
  const words = plannedWords(parameters, changes);
  for (const word of Object.keys(words) as LogWord[]) {
    if (words[word] !== readWord(parameters, word)) planned.push(() => parameters.writeSetting(word, 'DWord', words[word]));
  }
  const stage = (registry: string, kind: DnsDiagnosticsKind, value: DnsDiagnosticsValue): string | null => {
    switch (kind) {
      case 'flag': planned.push(() => parameters.writeSetting(registry, 'DWord', value === true ? 1 : 0)); return null;
      case 'count': {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number > 0xFFFFFFFF) return PARAMETER_ERROR;
        planned.push(() => parameters.writeSetting(registry, 'DWord', number));
        return null;
      }
      case 'text': planned.push(() => parameters.writeSetting(registry, 'String', String(value))); return null;
      case 'addresses': {
        const addresses = value as readonly string[];
        const invalid = addresses.find(address => IPAddress.tryParse(address) === null);
        if (invalid !== undefined) return `"${invalid}" is not a valid IPv4 address.`;
        planned.push(() => parameters.writeSetting(registry, 'MultiString', joinMultiString(addresses)));
        return null;
      }
    }
  };
  if (changes.all === true) {
    const refused = stage('EventLogLevel', 'count', ALL_EVENTS_LOG_LEVEL);
    if (refused !== null) return refused;
  }
  if (changes.all !== undefined) stage('EnableLogFileRollover', 'flag', changes.all);
  for (const [property, value] of changes.values ?? []) {
    const spec = DIAGNOSTICS_PROPERTIES.find(candidate => candidate.property.toLowerCase() === property.toLowerCase());
    if (spec === undefined || spec.word !== null) continue;
    const refused = stage(spec.registry as string, spec.kind, value);
    if (refused !== null) return refused;
  }
  for (const write of planned) write();
  return null;
}

export interface DnsDebugLogSettings {
  readonly path: string;
  readonly maxBytes: number;
  readonly remotes: readonly string[];
}

export function readLogLevel(parameters: DnsServerParameters): number {
  return readWord(parameters, 'LogLevel');
}

export function readDebugLogSettings(parameters: DnsServerParameters): DnsDebugLogSettings {
  return {
    path: String(parameters.rawSetting('LogFilePath') ?? ''),
    maxBytes: parameters.count('LogFileMaxSize', DEFAULT_LOG_FILE_MAX_BYTES),
    remotes: splitMultiString(String(parameters.rawSetting('LogIPFilterList') ?? '')),
  };
}
