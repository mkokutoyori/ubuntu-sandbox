import {
  DEFAULT_PRI, FACILITY_TEXT, LOG_FACILITY_INVALID, LOG_PRI_INVALID, SEVERITY_TEXT, facilityOf, normalizePri, parsePri, severityOf,
} from '@/network/syslog/codec/SyslogPriority';
import type { SyslogTime } from '@/network/syslog/codec/SyslogTime';

export const MAX_PROGRAM_NAME_BUFFER = 16;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ReceiveInfo {
  readonly rawMsg: string;
  readonly receivedAt: SyslogTime;
  readonly inputName: string;
  readonly fromHost: string | null;
  readonly fromHostIp: string | null;
  readonly fromHostPort: string | null;
  readonly internal?: boolean;
  readonly parseHostname?: boolean;
  readonly ignoreDate?: boolean;
  readonly noPriInRaw?: boolean;
  readonly defaultTimeZone?: string;
  readonly localHostName: string;
}

export class RsyslogMessage {
  rawMsg: string;
  offAfterPri = 0;
  facility = DEFAULT_PRI >> 3;
  severity = DEFAULT_PRI & 7;
  protocolVersion: 0 | 1 = 0;
  timestamp: SyslogTime;
  readonly receivedAt: SyslogTime;
  hostname: string | null = null;
  tag = '';
  msg = '';
  appName: string | null = null;
  procId: string | null = null;
  msgId: string | null = null;
  structuredData: string | null = null;
  inputName: string;
  fromHost: string | null;
  fromHostIp: string | null;
  fromHostPort: string | null;
  parseSuccess = false;
  readonly internal: boolean;
  readonly parseHostname: boolean;
  readonly ignoreDate: boolean;
  readonly noPriInRaw: boolean;
  readonly localHostName: string;
  rulesetName: string | null = null;
  cee: { [key: string]: JsonValue } = {};
  localVariables: { [key: string]: JsonValue } = {};
  discarded = false;

  constructor(info: ReceiveInfo) {
    this.rawMsg = info.rawMsg;
    this.receivedAt = info.receivedAt;
    this.timestamp = info.receivedAt;
    this.inputName = info.inputName;
    this.fromHost = info.fromHost;
    this.fromHostIp = info.fromHostIp;
    this.fromHostPort = info.fromHostPort;
    this.internal = info.internal === true;
    this.parseHostname = info.parseHostname !== false;
    this.ignoreDate = info.ignoreDate === true;
    this.noPriInRaw = info.noPriInRaw === true;
    this.localHostName = info.localHostName;
    this.msg = info.rawMsg;
  }

  setPri(pri: number): void {
    const normalized = normalizePri(pri);
    this.facility = facilityOf(normalized);
    this.severity = severityOf(normalized);
  }

  get pri(): number {
    return this.facility * 8 + this.severity;
  }

  parsePriFromRaw(): void {
    if (this.noPriInRaw) {
      this.setPri(DEFAULT_PRI);
      this.offAfterPri = 0;
      return;
    }
    if (this.rawMsg.length > 0 && this.rawMsg[0] === '<') {
      const parsed = parsePri(this.rawMsg);
      if (parsed !== null) {
        this.setPri(parsed.pri);
        this.offAfterPri = parsed.offset;
      } else {
        this.setPri(LOG_PRI_INVALID);
        this.offAfterPri = 0;
      }
    } else {
      this.setPri(DEFAULT_PRI);
      this.offAfterPri = 0;
    }
  }

  get hasInvalidFacility(): boolean {
    return this.facility === LOG_FACILITY_INVALID;
  }

  get rawMsgAfterPri(): string {
    return this.rawMsg.slice(this.offAfterPri);
  }

  get hostnameOrSender(): string {
    return this.hostname ?? this.fromHost ?? '';
  }

  get effectiveTag(): string {
    if (this.tag.length > 0) return this.tag;
    if (this.protocolVersion === 1) {
      const procId = this.procId ?? '-';
      const appName = this.appName ?? '';
      return procId === '-' ? appName : `${appName}[${procId}]`;
    }
    return '';
  }

  get programName(): string {
    const tag = this.effectiveTag;
    let end = 0;
    while (end < tag.length) {
      const code = tag.charCodeAt(end);
      if (code < 32 || code > 126 || tag[end] === ':' || tag[end] === '[' || tag[end] === '/') break;
      end++;
    }
    return tag.slice(0, end);
  }

  get effectiveAppName(): string {
    if (this.appName !== null) return this.appName;
    return this.protocolVersion === 0 ? this.programName : '';
  }

  get effectiveProcId(): string {
    if (this.procId !== null) return this.procId;
    if (this.protocolVersion !== 0) return '-';
    const tag = this.effectiveTag;
    const open = tag.indexOf('[');
    if (open < 0) return '-';
    const close = tag.indexOf(']', open + 1);
    return close < 0 ? '-' : tag.slice(open + 1, close);
  }

  get effectiveMsgId(): string {
    return this.msgId ?? '-';
  }

  get effectiveStructuredData(): string {
    return this.structuredData ?? '-';
  }

  get facilityText(): string {
    return FACILITY_TEXT[this.facility] ?? 'invld';
  }

  get severityText(): string {
    return SEVERITY_TEXT[this.severity] ?? 'invld';
  }

  get priText(): string {
    return `${this.facilityText}.${this.severityText}`;
  }
}
