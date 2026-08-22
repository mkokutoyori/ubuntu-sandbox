import type { FirewallLogRecord } from '../../../logging/FirewallLogStore';

export type FortiLogFormat = 'default' | 'csv' | 'cef' | 'rfc5424';

const CEF_SEVERITY: Readonly<Record<string, number>> = Object.freeze({
  emergency: 10, alert: 9, critical: 8, error: 7,
  warning: 5, notice: 4, information: 3, debug: 1,
});

const SYSLOG_SEVERITY: Readonly<Record<string, number>> = Object.freeze({
  emergency: 0, alert: 1, critical: 2, error: 3,
  warning: 4, notice: 5, information: 6, debug: 7,
});

export interface FortiLogContext {
  readonly hostname: string;
  readonly serial: string;
  readonly version: string;
  readonly facility: number;
}

export function formatLogRecord(
  record: FirewallLogRecord, format: FortiLogFormat, context: FortiLogContext,
): string {
  switch (format) {
    case 'csv': return csvLine(record, context);
    case 'cef': return cefLine(record, context);
    case 'rfc5424': return rfc5424Line(record, context);
    default: return keyValueLine(record, context);
  }
}

export function orderedFields(
  record: FirewallLogRecord, context: FortiLogContext,
): ReadonlyArray<readonly [string, string]> {
  const stamp = new Date(record.at);
  const head: Array<readonly [string, string]> = [
    ['date', isoDate(stamp)],
    ['time', isoTime(stamp)],
    ['eventtime', String(record.at * 1_000_000)],
    ['logid', record.id],
    ['type', record.type],
    ['subtype', record.subtype],
    ['level', record.level],
    ['vd', 'root'],
    ['devname', context.hostname],
    ['devid', context.serial],
  ];
  for (const [name, value] of record.fields) head.push([name, value]);
  return Object.freeze(head);
}

function keyValueLine(record: FirewallLogRecord, context: FortiLogContext): string {
  return orderedFields(record, context)
    .map(([name, value]) => `${name}=${quoted(name, value)}`)
    .join(' ');
}

function csvLine(record: FirewallLogRecord, context: FortiLogContext): string {
  return orderedFields(record, context)
    .map(([, value]) => `"${value.replace(/"/g, '""')}"`)
    .join(',');
}

function cefLine(record: FirewallLogRecord, context: FortiLogContext): string {
  const severity = CEF_SEVERITY[record.level] ?? 3;
  const extension = orderedFields(record, context)
    .map(([name, value]) => `${name}=${value.replace(/([=\\|])/g, '\\$1')}`)
    .join(' ');

  return `CEF:0|Fortinet|Fortigate|${context.version}|${record.id}`
    + `|${record.type}:${record.subtype}|${severity}|${extension}`;
}

function rfc5424Line(record: FirewallLogRecord, context: FortiLogContext): string {
  const priority = context.facility * 8 + (SYSLOG_SEVERITY[record.level] ?? 6);
  const stamp = new Date(record.at).toISOString();
  const structured = orderedFields(record, context)
    .map(([name, value]) => `${name}="${value.replace(/(["\\\]])/g, '\\$1')}"`)
    .join(' ');

  return `<${priority}>1 ${stamp} ${context.hostname} FortiGate - ${record.id}`
    + ` [FTNTFGT@12356 ${structured}]`;
}

function quoted(name: string, value: string): string {
  if (ALWAYS_QUOTED.has(name)) return `"${value}"`;
  if (NEVER_QUOTED.has(name)) return value;
  if (/^\d+$/.test(value)) return value;
  return `"${value}"`;
}

const UNQUOTED_LOG_FIELDS: readonly string[] = Object.freeze([
  'date', 'time', 'eventtime', 'srcip', 'srcport', 'dstip', 'dstport', 'proto',
  'policyid', 'sessionid', 'sentbyte', 'rcvdbyte', 'sentpkt', 'rcvdpkt',
  'duration', 'transip', 'tranip', 'tranport', 'transport', 'cfgtid',
]);

const QUOTED_LOG_FIELDS: readonly string[] = Object.freeze([
  'logid', 'trandisp',
]);

const NEVER_QUOTED: ReadonlySet<string> = new Set(UNQUOTED_LOG_FIELDS);

const ALWAYS_QUOTED: ReadonlySet<string> = new Set(QUOTED_LOG_FIELDS);

function isoDate(stamp: Date): string {
  return `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())}`;
}

function isoTime(stamp: Date): string {
  return `${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}:${pad(stamp.getUTCSeconds())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
