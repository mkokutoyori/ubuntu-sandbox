import type { NtpAssociation } from '../../../ntp/types';
import type {
  ActivityReport, AuthReport, ChronyViewPort, ClientReport, NtpDataReport, SelectReport, ServerStatsReport,
  SourceReport, SourceState, SourcestatsReport, TrackingReport,
} from './ChronyDaemonView';
import type { SmoothingReport } from '../../../ntp/TimeSmoothing';
import {
  PKT_TYPE_REPLY, PROTO_VERSION, PROTO_VERSION_MISMATCH_COMPAT_SERVER, REPLY_HEADER_LENGTH, REQ, RPY, STT, WireReader,
  encodeRequest, parseReplyHeader, readActivity, readManualList, readSmoothing, readSourceData, readSourcestats,
  readTracking, replyLengthForCode, type WireWriter,
} from './ChronyCmdmon';

export interface CommandSocket {
  send(payload: Uint8Array): string | null;
  peekError(): string | null;
  close(): void;
}

export interface CommandTransport {
  open(host: string, port: number, onDatagram: (bytes: Uint8Array) => void): CommandSocket | null;
}

export interface CommandReply {
  readonly status: number;
  readonly reply: number;
  readonly bytes: Uint8Array;
}

const SOURCE_STATE_NAMES: readonly SourceState[] = ['selected', 'nonselectable', 'falseticker', 'jittery', 'unselected', 'selectable'];

export class ChronyCommandClient {
  private socket: CommandSocket | null = null;
  private inbox: Uint8Array[] = [];
  private sequenceState = 0x2545f491;
  timeoutMs = 1000;
  retries = 2;

  constructor(
    private readonly transport: CommandTransport,
    private readonly host: string,
    private readonly port: number,
    private readonly wait: (seconds: number) => Promise<void>,
  ) {}

  private nextSequence(): number {
    this.sequenceState = (Math.imul(this.sequenceState, 1664525) + 1013904223) >>> 0;
    return this.sequenceState;
  }

  open(): boolean {
    if (this.socket !== null) return true;
    this.socket = this.transport.open(this.host, this.port, (bytes) => { this.inbox.push(bytes); });
    return this.socket !== null;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private matching(command: number, sequence: number): CommandReply | 'short' | null {
    while (this.inbox.length > 0) {
      const bytes = this.inbox.shift()!;
      if (bytes.length < REPLY_HEADER_LENGTH) continue;
      const header = parseReplyHeader(bytes);
      const versionOk = header.version === PROTO_VERSION
        || (header.version >= PROTO_VERSION_MISMATCH_COMPAT_SERVER - 1 && header.status === STT.BADPKTVERSION);
      if (!versionOk || header.packetType !== PKT_TYPE_REPLY || header.res1 !== 0 || header.res2 !== 0
        || header.command !== command || header.sequence !== sequence) continue;
      if (bytes.length < replyLengthForCode(header.reply)) return 'short';
      return { status: header.status, reply: header.reply, bytes };
    }
    return null;
  }

  async request(command: number, fill?: (writer: WireWriter) => void): Promise<CommandReply | null> {
    if (!this.open()) return null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const sequence = this.nextSequence();
      this.inbox = [];
      const error = this.socket!.send(encodeRequest(command, sequence, attempt, fill));
      if (error !== null) return null;
      let found = this.matching(command, sequence);
      if (found === null && this.socket!.peekError() === null) {
        await this.wait((this.timeoutMs / 1000) * 2 ** attempt);
        found = this.matching(command, sequence);
      }
      if (found !== null && found !== 'short') return found;
    }
    return null;
  }
}

export const STATUS_LINES: Readonly<Record<number, string>> = {
  [STT.FAILED]: '500 Failure',
  [STT.UNAUTH]: '501 Not authorised',
  [STT.INVALID]: '502 Invalid command',
  [STT.NOSUCHSOURCE]: '503 No such source',
  [STT.INVALIDTS]: '504 Duplicate or stale logon detected',
  [STT.NOTENABLED]: '505 Facility not enabled in daemon',
  [STT.BADSUBNET]: '507 Bad subnet',
  [STT.NOHOSTACCESS]: '510 No command access from this host',
  [STT.SOURCEALREADYKNOWN]: '511 Source already present',
  [STT.TOOMANYSOURCES]: '512 Too many sources present',
  [STT.NORTC]: '513 RTC driver not running',
  [STT.BADRTCFILE]: '514 Can\'t write RTC parameters',
  [STT.INVALIDAF]: '515 Invalid address family',
  [STT.BADSAMPLE]: '516 Sample index out of range',
  [STT.BADPKTVERSION]: '517 Protocol version mismatch',
  [STT.BADPKTLENGTH]: '518 Packet length mismatch',
  [STT.INACTIVE]: '519 Client logging is not active in the daemon',
  [STT.INVALIDNAME]: '521 Invalid name',
  [STT.ACCESSALLOWED]: '208 Access allowed',
  [STT.ACCESSDENIED]: '209 Access denied',
};

export function statusLine(status: number): string {
  return STATUS_LINES[status] ?? '520 Got unexpected error from daemon';
}

const PRIVILEGED_CODES: Readonly<Record<string, number>> = {
  online: REQ.ONLINE, offline: REQ.OFFLINE, onoffline: REQ.ONOFFLINE, burst: REQ.BURST, minpoll: REQ.MODIFY_MINPOLL,
  maxpoll: REQ.MODIFY_MAXPOLL, dump: REQ.DUMP, maxdelay: REQ.MODIFY_MAXDELAY, maxdelayratio: REQ.MODIFY_MAXDELAYRATIO,
  maxdelaydevratio: REQ.MODIFY_MAXDELAYDEVRATIO, minstratum: REQ.MODIFY_MINSTRATUM, polltarget: REQ.MODIFY_POLLTARGET,
  maxupdateskew: REQ.MODIFY_MAXUPDATESKEW, settime: REQ.SETTIME, local: REQ.LOCAL2, rekey: REQ.REKEY,
  accheck: REQ.ACCHECK, cmdaccheck: REQ.CMDACCHECK, delete: REQ.DEL_SOURCE, writertc: REQ.WRITERTC, trimrtc: REQ.TRIMRTC,
  cyclelogs: REQ.CYCLELOGS, reselect: REQ.RESELECT, reselectdist: REQ.RESELECTDISTANCE, smoothtime: REQ.SMOOTHTIME,
  refresh: REQ.REFRESH, shutdown: REQ.SHUTDOWN, reset: REQ.RESET_SOURCES, reload: REQ.RELOAD_SOURCES,
  selectopts: REQ.MODIFY_SELECTOPTS, serverstats: REQ.SERVER_STATS, add: REQ.ADD_SOURCE,
};

function allowDenyCode(command: string, line: string): number {
  const all = line.split(' ')[0] === 'all';
  const base = { allow: REQ.ALLOW, deny: REQ.DENY, cmdallow: REQ.CMDALLOW, cmddeny: REQ.CMDDENY }[command] ?? REQ.ALLOW;
  return all ? base + 1 : base;
}

export function privilegedCode(command: string, line: string): number | null {
  if (command === 'allow' || command === 'deny' || command === 'cmdallow' || command === 'cmddeny') return allowDenyCode(command, line);
  if (command === 'manual') return line.startsWith('delete') ? REQ.MANUAL_DELETE : REQ.MANUAL;
  if (command === 'makestep') return line === '' ? REQ.MAKESTEP : REQ.MODIFY_MAKESTEP;
  return PRIVILEGED_CODES[command] ?? null;
}

function trackingReport(r: WireReader): TrackingReport {
  const t = readTracking(r);
  return {
    referenceId: t.refId, referenceName: t.ip ?? refIdName(t.refId), stratum: t.stratum, referenceTime: t.refTime,
    referenceTimeNanoseconds: t.refTimeNanoseconds,
    currentCorrection: t.currentCorrection, lastOffset: t.lastOffset, rmsOffset: t.rmsOffset, frequencyPpm: t.frequencyPpm,
    residualFrequencyPpm: t.residualFrequencyPpm, skewPpm: t.skewPpm, rootDelay: t.rootDelay,
    rootDispersion: t.rootDispersion, updateInterval: t.lastUpdateInterval, leap: t.leap,
  };
}

function refIdName(refId: number): string {
  let text = '';
  for (let i = 0; i < 4; i++) {
    const c = (refId >>> (24 - i * 8)) & 0xff;
    if (c >= 0x20 && c < 0x7f) text += String.fromCharCode(c);
  }
  return text;
}

export interface FetchOutcome { ok: boolean; text?: string | null }

export class RemoteChronyView implements ChronyViewPort {
  private sourceList: SourceReport[] = [];
  private statsList: SourcestatsReport[] = [];
  private trackingValue: TrackingReport | null = null;
  private activityValue: ActivityReport | null = null;
  private smoothingValue: SmoothingReport | null = null;
  private knownName: string | null = null;
  private count = 0;
  private countFresh = false;
  manualSamples: { atMs: number; slewed: number; original: number; residual: number }[] = [];

  constructor(private readonly client: ChronyCommandClient) {}

  private async exchange(command: number, expected: number, fill?: (writer: WireWriter) => void): Promise<CommandReply | FetchOutcome> {
    const reply = await this.client.request(command, fill);
    if (reply === null) return { ok: false, text: null };
    if (reply.status !== STT.SUCCESS) return { ok: false, text: statusLine(reply.status) };
    if (reply.reply !== expected) return { ok: false, text: '508 Bad reply from daemon' };
    return reply;
  }

  private async sourceCount(): Promise<number | FetchOutcome> {
    const reply = await this.exchange(REQ.N_SOURCES, RPY.N_SOURCES);
    if ('ok' in reply) return reply;
    return new WireReader(reply.bytes, REPLY_HEADER_LENGTH).u32();
  }

  async fetch(command: string, line: string): Promise<FetchOutcome> {
    switch (command) {
      case 'tracking': case 'waitsync': {
        const reply = await this.exchange(REQ.TRACKING, RPY.TRACKING);
        if ('ok' in reply) return reply;
        this.trackingValue = trackingReport(new WireReader(reply.bytes, REPLY_HEADER_LENGTH));
        return { ok: true };
      }
      case 'sources': case 'sourcestats': {
        const n = await this.sourceCount();
        if (typeof n !== 'number') return n;
        this.count = n;
        this.sourceList = [];
        this.statsList = [];
        for (let i = 0; i < n; i++) {
          if (command === 'sources') {
            const reply = await this.exchange(REQ.SOURCE_DATA, RPY.SOURCE_DATA, (w) => w.u32(i));
            if ('ok' in reply) return reply;
            const d = readSourceData(new WireReader(reply.bytes, REPLY_HEADER_LENGTH));
            this.sourceList.push({
              ip: d.ip ?? '0.0.0.0', mode: d.mode === 1 ? 'peer' : 'client', state: SOURCE_STATE_NAMES[d.state] ?? 'nonselectable',
              stratum: d.stratum, poll: d.poll, reachability: d.reachability, sinceSample: d.sinceSample,
              latestMeasurement: d.latestMeasurement, originalLatestMeasurement: d.originalLatestMeasurement,
              latestMeasurementError: d.latestMeasurementError,
            });
          } else {
            const reply = await this.exchange(REQ.SOURCESTATS, RPY.SOURCESTATS, (w) => w.u32(i));
            if ('ok' in reply) return reply;
            const d = readSourcestats(new WireReader(reply.bytes, REPLY_HEADER_LENGTH));
            this.statsList.push({
              ip: d.ip ?? '0.0.0.0', samples: d.samples, runs: d.runs, spanSeconds: d.spanSeconds,
              residualFrequencyPpm: d.residualFrequencyPpm, skewPpm: d.skewPpm, estimatedOffset: d.estimatedOffset,
              estimatedOffsetError: d.estimatedOffsetError, standardDeviation: d.standardDeviation,
            });
          }
        }
        return { ok: true };
      }
      case 'activity': {
        const reply = await this.exchange(REQ.ACTIVITY, RPY.ACTIVITY);
        if ('ok' in reply) return reply;
        this.activityValue = readActivity(new WireReader(reply.bytes, REPLY_HEADER_LENGTH));
        return { ok: true };
      }
      case 'smoothing': {
        const reply = await this.exchange(REQ.SMOOTHING, RPY.SMOOTHING);
        if ('ok' in reply) return reply;
        const s = readSmoothing(new WireReader(reply.bytes, REPLY_HEADER_LENGTH));
        this.smoothingValue = {
          active: (s.flags & 1) !== 0, leapOnly: (s.flags & 2) !== 0, offset: s.offset, frequencyPpm: s.frequencyPpm,
          wanderPpm: s.wanderPpm, lastUpdateAgo: s.lastUpdateAgo, remainingTime: s.remainingTime,
        };
        return { ok: true };
      }
      case 'rtcdata': {
        const reply = await this.exchange(REQ.RTCREPORT, RPY.RTC);
        return 'ok' in reply ? reply : { ok: false, text: '508 Bad reply from daemon' };
      }
      case 'manual': {
        const reply = await this.exchange(REQ.MANUAL_LIST, RPY.MANUAL_LIST2);
        if ('ok' in reply) return reply;
        this.manualSamples = readManualList(new WireReader(reply.bytes, REPLY_HEADER_LENGTH))
          .map((s) => ({ atMs: s.when * 1000, slewed: s.slewedOffset, original: s.originalOffset, residual: s.residual }));
        return { ok: true };
      }
      case 'count': {
        const n = await this.sourceCount();
        if (typeof n !== 'number') return n;
        this.count = n;
        this.countFresh = true;
        return { ok: true };
      }
      case 'sourcename': {
        const reply = await this.exchange(REQ.NTP_SOURCE_NAME, RPY.NTP_SOURCE_NAME, (w) => w.ip(line));
        if ('ok' in reply) return reply;
        this.knownName = new WireReader(reply.bytes, REPLY_HEADER_LENGTH).text(256);
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  async denied(command: string, line: string): Promise<{ status: number } | null> {
    const first = async (code: number, fill?: (writer: WireWriter) => void): Promise<number | null> => {
      const reply = await this.client.request(code, fill);
      return reply === null ? null : reply.status;
    };
    switch (command) {
      case 'selectdata': case 'authdata': case 'ntpdata': {
        if (line === '' || command === 'selectdata') {
          let n: number | FetchOutcome = this.count;
          if (!this.countFresh) n = await this.sourceCount();
          this.countFresh = false;
          if (typeof n !== 'number') return null;
          if (n === 0) return { status: STT.SUCCESS };
          let address: string | null = null;
          if (command !== 'selectdata') {
            const data = await this.exchange(REQ.SOURCE_DATA, RPY.SOURCE_DATA, (w) => w.u32(0));
            if ('ok' in data) return null;
            address = readSourceData(new WireReader(data.bytes, REPLY_HEADER_LENGTH)).ip;
          }
          const code = command === 'selectdata' ? REQ.SELECT_DATA : command === 'authdata' ? REQ.AUTH_DATA : REQ.NTP_DATA;
          const status = await first(code, (w) => { if (command === 'selectdata') w.u32(0); else w.ip(address); });
          return status === null ? null : { status };
        }
        const status = await first(command === 'authdata' ? REQ.AUTH_DATA : REQ.NTP_DATA, (w) => w.ip(line.split(' ')[0]));
        return status === null ? null : { status };
      }
      case 'clients': {
        const status = await first(REQ.CLIENT_ACCESSES_BY_INDEX3, (w) => w.u32(0).u32(8).u32(0).u32(0));
        return status === null ? null : { status };
      }
      default: {
        const code = privilegedCode(command, line);
        if (code === null) return { status: STT.UNAUTH };
        const status = await first(code);
        return status === null ? null : { status };
      }
    }
  }

  configure(timeoutMs: number, retries: number): void {
    this.client.timeoutMs = timeoutMs;
    this.client.retries = retries;
  }

  activity(): ActivityReport { return this.activityValue!; }
  sources(): SourceReport[] { return this.sourceList; }
  sourcestats(): SourcestatsReport[] { return this.statsList; }
  tracking(): TrackingReport { return this.trackingValue!; }
  smoothingReport(): SmoothingReport | null { return this.smoothingValue; }
  findSource(ip: string): NtpAssociation | undefined {
    return this.knownName !== null && this.knownName === ip ? ({ serverIp: ip } as NtpAssociation) : undefined;
  }
  matching(): NtpAssociation[] { return Array.from({ length: this.count }, () => ({}) as NtpAssociation); }
  authData(): AuthReport[] { return Array.from({ length: this.count }, () => ({}) as AuthReport); }
  selectData(): SelectReport[] { return Array.from({ length: this.count }, () => ({}) as SelectReport); }
  clients(): ClientReport[] { return []; }
  ntpData(): NtpDataReport { return {} as NtpDataReport; }
  serverStats(): ServerStatsReport { return { values: [] }; }
  clearClients(): void { return; }
  reselect(): void { return; }
  resetSources(): void { return; }
  setCriteria(): void { return; }
  setMaxUpdateSkew(): void { return; }
  setOnline(): void { return; }
  setReselectDistance(): void { return; }
  smoothTime(): boolean { return false; }
  startBurst(): void { return; }
}
