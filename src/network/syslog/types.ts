import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const UDP_PORT_SYSLOG = 514;

export type SyslogSeverityName =
  | 'emergency'
  | 'alert'
  | 'critical'
  | 'error'
  | 'warning'
  | 'notification'
  | 'informational'
  | 'debugging';

export const SYSLOG_SEVERITY: Record<SyslogSeverityName, number> = {
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notification: 5,
  informational: 6,
  debugging: 7,
};

export type SyslogFacilityName =
  | 'kern' | 'user' | 'mail' | 'daemon' | 'auth' | 'syslog'
  | 'lpr' | 'news' | 'uucp' | 'cron' | 'authpriv' | 'ftp'
  | 'local0' | 'local1' | 'local2' | 'local3'
  | 'local4' | 'local5' | 'local6' | 'local7';

export const SYSLOG_FACILITY: Record<SyslogFacilityName, number> = {
  kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5,
  lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18, local3: 19,
  local4: 20, local5: 21, local6: 22, local7: 23,
};

export interface SyslogPacket extends NetworkPdu {
  type: 'syslog';
  facility: number;
  severity: number;
  hostname: string;
  tag: string;
  message: string;
  timestamp: string;
}

export interface SyslogServer {
  ip: string;
  facility: SyslogFacilityName;
  severityThreshold: SyslogSeverityName;
  count: number;
  lastSentMs: number;
}

export interface SyslogConfig {
  enabled: boolean;
  servers: Map<string, SyslogServer>;
  defaultFacility: SyslogFacilityName;
  defaultSeverityThreshold: SyslogSeverityName;
  sourceInterface: string | null;
  sequenceNumbers: boolean;
  globalSequence: number;
}

export function createDefaultSyslogConfig(): SyslogConfig {
  return {
    enabled: true, servers: new Map(),
    defaultFacility: 'local7',
    defaultSeverityThreshold: 'informational',
    sourceInterface: null,
    sequenceNumbers: false,
    globalSequence: 0,
  };
}

export function defaultServer(ip: string,
                              facility: SyslogFacilityName = 'local7',
                              severityThreshold: SyslogSeverityName = 'informational'): SyslogServer {
  return { ip, facility, severityThreshold, count: 0, lastSentMs: 0 };
}

export function priValue(facility: number, severity: number): number {
  return facility * 8 + severity;
}

export function severityFromLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): SyslogSeverityName {
  if (level === 'debug') return 'debugging';
  if (level === 'info') return 'informational';
  if (level === 'warn') return 'warning';
  return 'error';
}

export function shouldForward(threshold: SyslogSeverityName, severity: SyslogSeverityName): boolean {
  return SYSLOG_SEVERITY[severity] <= SYSLOG_SEVERITY[threshold];
}

export function formatBsdSyslog(packet: SyslogPacket): string {
  const pri = priValue(packet.facility, packet.severity);
  return `<${pri}>${packet.timestamp} ${packet.hostname} ${packet.tag}: ${packet.message}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bsdTimestamp(dateMs: number): string {
  const d = new Date(dateMs);
  const day = d.getUTCDate().toString().padStart(2, ' ');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${day} ${hh}:${mm}:${ss}`;
}
