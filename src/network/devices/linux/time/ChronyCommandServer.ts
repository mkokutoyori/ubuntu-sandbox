import { simulationNowMs } from '@/network/core/SystemClock';
import { tryIpToUint32 } from '../../../core/ip';
import { IPAddress } from '../../../core/types';
import { TokenBucketLimiter, type RateLimit } from '../../../ntp/RateLimiter';
import type { ChronyDaemonView, SourceState } from './ChronyDaemonView';
import type { LinuxChronyService } from './LinuxChronyService';
import {
  MAX_REQUEST_LENGTH, PERMIT_OPEN, PKT_TYPE_REQUEST, PROTO_VERSION, PROTO_VERSION_MISMATCH_COMPAT_SERVER,
  REPLY_HEADER_LENGTH, REQUEST_HEADER_LENGTH, REQ, RPY, STT, N_REQUEST_TYPES, WireReader, encodeReply, parseRequestHeader,
  replyLengthForCode, requestLength, writeActivity, writeManualList, writeSmoothing, writeSourceData, writeSourcestats,
  writeTracking,
} from './ChronyCmdmon';

export interface CommandReplyTransport {
  send(destination: IPAddress, destinationPort: number, sourcePort: number, source: IPAddress | undefined, payload: Uint8Array): boolean;
}

const SOURCE_STATES: Readonly<Record<SourceState, number>> = {
  selected: 0, nonselectable: 1, falseticker: 2, jittery: 3, unselected: 4, selectable: 5,
};

function refIdText(refId: number): string {
  let text = '';
  for (let i = 0; i < 4; i++) {
    const c = (refId >>> (24 - i * 8)) & 0xff;
    if (c >= 0x20 && c < 0x7f) text += String.fromCharCode(c);
  }
  return text;
}

export class ChronyCommandServer {
  private readonly limiter = new TokenBucketLimiter(null);

  constructor(
    private readonly service: LinuxChronyService,
    private readonly view: () => ChronyDaemonView | null,
    private readonly transport: CommandReplyTransport,
  ) {}

  setRateLimit(limit: RateLimit | null): void { this.limiter.configure(limit); }

  handle(sourceIp: IPAddress, sourcePort: number, destinationIp: IPAddress, localPort: number, bytes: Uint8Array): void {
    const remote = sourceIp.toString();
    const localhost = remote === '127.0.0.1';
    if (!localhost && !this.service.isCommandClientAllowed(sourceIp)) return;
    const readLength = bytes.length;
    if (readLength < REQUEST_HEADER_LENGTH || readLength < REPLY_HEADER_LENGTH || readLength > MAX_REQUEST_LENGTH) return;
    const header = parseRequestHeader(bytes);
    if (header.packetType !== PKT_TYPE_REQUEST || header.res1 !== 0 || header.res2 !== 0) return;
    if (!localhost && this.limiter.check(remote, simulationNowMs()).verdict !== 'serve') return;
    const reply = (fill?: Parameters<typeof encodeReply>[1], replyCode: number = RPY.NULL, status: number = STT.SUCCESS): void => {
      const out = encodeReply({ command: header.command, sequence: header.sequence, reply: replyCode, status }, fill);
      if (readLength < replyLengthForCode(replyCode)) return;
      this.transport.send(sourceIp, sourcePort, localPort, destinationIp, out);
    };
    if (header.version !== PROTO_VERSION) {
      if (header.version >= PROTO_VERSION_MISMATCH_COMPAT_SERVER) reply(undefined, RPY.NULL, STT.BADPKTVERSION);
      return;
    }
    const expected = requestLength(header.command, header.version);
    if (header.command >= N_REQUEST_TYPES || expected < REQUEST_HEADER_LENGTH || expected === 0) {
      reply(undefined, RPY.NULL, STT.INVALID);
      return;
    }
    if (readLength < expected) {
      reply(undefined, RPY.NULL, STT.BADPKTLENGTH);
      return;
    }
    this.service.countCommandPacket();
    if (!PERMIT_OPEN.has(header.command)) {
      reply(undefined, RPY.NULL, STT.UNAUTH);
      return;
    }
    const view = this.view();
    if (view === null) {
      reply(undefined, RPY.NULL, STT.FAILED);
      return;
    }
    const body = new WireReader(bytes, REQUEST_HEADER_LENGTH);
    switch (header.command) {
      case REQ.NULL:
      case REQ.LOGON:
        reply(undefined, RPY.NULL, header.command === REQ.LOGON ? STT.FAILED : STT.SUCCESS);
        return;
      case REQ.N_SOURCES:
        reply((w) => w.u32(view.sources().length), RPY.N_SOURCES);
        return;
      case REQ.SOURCE_DATA: {
        const source = view.sources()[body.u32()];
        if (source === undefined) { reply(undefined, RPY.NULL, STT.NOSUCHSOURCE); return; }
        reply((w) => writeSourceData(w, {
          ip: source.ip, poll: source.poll, stratum: source.stratum, state: SOURCE_STATES[source.state],
          mode: source.mode === 'peer' ? 1 : 0, flags: 0, reachability: source.reachability, sinceSample: source.sinceSample,
          originalLatestMeasurement: source.originalLatestMeasurement, latestMeasurement: source.latestMeasurement,
          latestMeasurementError: source.latestMeasurementError,
        }), RPY.SOURCE_DATA);
        return;
      }
      case REQ.TRACKING: {
        const t = view.tracking();
        reply((w) => writeTracking(w, {
          refId: t.referenceId, ip: tryIpToUint32(t.referenceName) === null ? null : t.referenceName, stratum: t.stratum,
          leap: t.leap, refTime: t.referenceTime, currentCorrection: t.currentCorrection, lastOffset: t.lastOffset,
          rmsOffset: t.rmsOffset, frequencyPpm: t.frequencyPpm, residualFrequencyPpm: t.residualFrequencyPpm,
          skewPpm: t.skewPpm, rootDelay: t.rootDelay, rootDispersion: t.rootDispersion, lastUpdateInterval: t.updateInterval,
        }), RPY.TRACKING);
        return;
      }
      case REQ.SOURCESTATS: {
        const row = view.sourcestats()[body.u32()];
        if (row === undefined) { reply(undefined, RPY.NULL, STT.NOSUCHSOURCE); return; }
        reply((w) => writeSourcestats(w, {
          refId: tryIpToUint32(row.ip) ?? 0, ip: row.ip, samples: row.samples, runs: row.runs, spanSeconds: row.spanSeconds,
          standardDeviation: row.standardDeviation, residualFrequencyPpm: row.residualFrequencyPpm, skewPpm: row.skewPpm,
          estimatedOffset: row.estimatedOffset, estimatedOffsetError: row.estimatedOffsetError,
        }), RPY.SOURCESTATS);
        return;
      }
      case REQ.RTCREPORT:
        reply(undefined, RPY.NULL, STT.NORTC);
        return;
      case REQ.MANUAL_LIST:
        reply((w) => writeManualList(w, this.service.getManualSamples().map((s) => ({
          when: s.atMs / 1000, slewedOffset: s.slewed, originalOffset: s.original, residual: s.residual,
        }))), RPY.MANUAL_LIST2);
        return;
      case REQ.ACTIVITY: {
        const a = view.activity();
        reply((w) => writeActivity(w, a), RPY.ACTIVITY);
        return;
      }
      case REQ.SMOOTHING: {
        const s = view.smoothingReport();
        if (s === null) { reply(undefined, RPY.NULL, STT.NOTENABLED); return; }
        reply((w) => writeSmoothing(w, {
          flags: (s.active ? 1 : 0) | (s.leapOnly ? 2 : 0), offset: s.offset, frequencyPpm: s.frequencyPpm,
          wanderPpm: s.wanderPpm, lastUpdateAgo: s.lastUpdateAgo, remainingTime: s.remainingTime,
        }), RPY.SMOOTHING);
        return;
      }
      case REQ.NTP_SOURCE_NAME: {
        const address = body.ip();
        const source = address === null ? undefined : view.findSource(address);
        if (source === undefined) { reply(undefined, RPY.NULL, STT.NOSUCHSOURCE); return; }
        reply((w) => w.text(source.serverIp, 256), RPY.NTP_SOURCE_NAME);
        return;
      }
      default:
        reply(undefined, RPY.NULL, STT.FAILED);
    }
  }
}

export { refIdText };
