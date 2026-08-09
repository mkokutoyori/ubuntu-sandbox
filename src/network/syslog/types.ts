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

const SYSLOG_SEVERITY_BY_NUM: readonly SyslogSeverityName[] = [
  'emergency', 'alert', 'critical', 'error',
  'warning', 'notification', 'informational', 'debugging',
];

/**
 * Reverse lookup for consumers of `device.syslog.entry` — that event's
 * `severity` uses the Cisco-style plural vocabulary (emergencies/alerts/…),
 * a distinct spelling from this module's singular SyslogSeverityName. Both
 * share the same 0-7 ordering, so severityNum is the safe bridge.
 */
export function syslogSeverityFromNum(n: number): SyslogSeverityName {
  return SYSLOG_SEVERITY_BY_NUM[n] ?? 'informational';
}

/**
 * Ce qu'un consommateur de `device.syslog.entry` doit reconstruire pour
 * retrouver la ligne que `show logging` affiche.
 *
 * L'événement porte `tag`, `severityNum`, `mnemonic` et `message`
 * SÉPARÉMENT — c'est justement à cela que sert le champ `mnemonic`, dont
 * le commentaire dans `events/types.ts` dit qu'il existe « pour
 * reconstituer le `%TAG-SEV-MNEMONIQUE` ». Chaque consommateur le
 * reconstruisait pourtant à sa façon, ou pas du tout, et les deux
 * conséquences ont été mesurées : l'agent syslog a déjà porté deux formes
 * selon le bus interne emprunté (voir son propre commentaire), et le
 * moteur EEM n'en construisait AUCUNE — il comparait le motif au seul
 * corps du message.
 *
 * Or un motif EEM se écrit sur le mnémonique : `event syslog pattern
 * "SYS-5-CONFIG_I"` ou `"UPDOWN.*FastEthernet0/0.*down"`. Ces chaînes
 * n'existent que dans le préfixe, jamais dans le corps, si bien que la
 * façon normale d'écrire un déclencheur ne déclenchait jamais rien.
 *
 * Une seule définition, donc, pour que les deux ne puissent pas diverger.
 */
export interface SyslogLineParts {
  readonly tag: string;
  readonly severityNum: number;
  readonly mnemonic?: string;
  readonly message: string;
}

/** `%SYS-5-CONFIG_I` — le préfixe seul, sans le corps. */
export function syslogTagOf(p: SyslogLineParts): string {
  const mnem = (p.mnemonic ?? syslogSeverityFromNum(p.severityNum)).toUpperCase();
  return `%${p.tag.toUpperCase()}-${p.severityNum}-${mnem}`;
}

/** `%SYS-5-CONFIG_I: Configured from console by console` — la ligne entière. */
export function syslogFullLine(p: SyslogLineParts): string {
  return `${syslogTagOf(p)}: ${p.message}`;
}

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
  /**
   * `logging host <ip> transport udp port <n>` : un collecteur qui
   * ecoute ailleurs que sur 514 ne recoit rien si on lui ecrit sur 514.
   */
  port: number;
  /**
   * `transport {udp|tcp}`. En TCP, RFC 6587 : les messages voyagent sur
   * UNE connexion, a la queue leu leu — d'ou le delimiteur, sans lequel
   * le collecteur ne sait pas ou l'un finit et l'autre commence.
   */
  transport: 'udp' | 'tcp';
  /** `logging delimiter tcp` : un saut de ligne apres chaque message. */
  delimiter: boolean;
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
  /**
   * `logging queue-limit [trap] <n>` : ce que la file de sortie garde en
   * attendant qu'une connexion s'ouvre. Un collecteur injoignable ne
   * doit pas faire grossir la memoire sans fin.
   */
  queueLimit: number;
}

export function createDefaultSyslogConfig(): SyslogConfig {
  return {
    enabled: true, servers: new Map(),
    defaultFacility: 'local7',
    defaultSeverityThreshold: 'informational',
    sourceInterface: null,
    sequenceNumbers: false,
    globalSequence: 0,
    queueLimit: 100,
  };
}

export function defaultServer(ip: string,
                              facility: SyslogFacilityName = 'local7',
                              severityThreshold: SyslogSeverityName = 'informational',
                              port: number = UDP_PORT_SYSLOG,
                              transport: 'udp' | 'tcp' = 'udp',
                              delimiter: boolean = false): SyslogServer {
  return { ip, port, transport, delimiter, facility, severityThreshold, count: 0, lastSentMs: 0 };
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
