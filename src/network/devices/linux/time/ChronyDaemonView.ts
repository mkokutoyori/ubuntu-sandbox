import { simulationNowMs } from '@/network/core/SystemClock';
import type { NtpAgent } from '../../../ntp/NtpAgent';
import type { NtpAssociation } from '../../../ntp/types';
import { isValidIPv4, tryIpToUint32 as ipv4ToUint32 } from '../../../core/ip';
import type { LinuxChronyService } from './LinuxChronyService';

export const NO_ELAPSED = 4294967295;
export const LOCAL_REFERENCE_ID = 0x7f7f0101;
export const UNSYNCHRONISED_ROOT = 1;

export type SourceState = 'selected' | 'nonselectable' | 'falseticker' | 'jittery' | 'unselected' | 'selectable';

export interface SourceReport {
  readonly ip: string;
  readonly mode: 'client' | 'peer';
  readonly state: SourceState;
  readonly stratum: number;
  readonly poll: number;
  readonly reachability: number;
  readonly sinceSample: number;
  readonly latestMeasurement: number;
  readonly originalLatestMeasurement: number;
  readonly latestMeasurementError: number;
}

export interface SourcestatsReport {
  readonly ip: string;
  readonly samples: number;
  readonly runs: number;
  readonly spanSeconds: number;
  readonly residualFrequencyPpm: number;
  readonly skewPpm: number;
  readonly estimatedOffset: number;
  readonly standardDeviation: number;
}

export interface TrackingReport {
  readonly referenceId: number;
  readonly referenceName: string;
  readonly stratum: number;
  readonly referenceTime: number;
  readonly currentCorrection: number;
  readonly lastOffset: number;
  readonly rmsOffset: number;
  readonly frequencyPpm: number;
  readonly residualFrequencyPpm: number;
  readonly skewPpm: number;
  readonly rootDelay: number;
  readonly rootDispersion: number;
  readonly updateInterval: number;
  readonly leap: number;
}

export interface SelectReport {
  readonly ip: string;
  readonly stateChar: string;
  readonly authenticated: boolean;
  readonly configuredOptions: string;
  readonly effectiveOptions: string;
  readonly lastSampleAgo: number;
  readonly score: number;
  readonly low: number;
  readonly high: number;
  readonly leap: number;
}

export interface AuthReport {
  readonly ip: string;
  readonly mode: string;
  readonly keyId: number;
  readonly keyType: number;
  readonly keyLength: number;
}

export interface NtpDataReport {
  readonly remoteIp: string;
  readonly remotePort: number;
  readonly localIp: string;
  readonly leap: number;
  readonly version: number;
  readonly mode: number;
  readonly stratum: number;
  readonly poll: number;
  readonly precision: number;
  readonly rootDelay: number;
  readonly rootDispersion: number;
  readonly referenceId: number;
  readonly referenceName: string;
  readonly referenceTime: number;
  readonly offset: number;
  readonly peerDelay: number;
  readonly peerDispersion: number;
  readonly responseTime: number;
  readonly tests: number;
  readonly interleaved: boolean;
  readonly authenticated: boolean;
  readonly transmitSource: string;
  readonly receiveSource: string;
  readonly totalTransmitted: number;
  readonly totalReceived: number;
  readonly totalValid: number;
  readonly totalGood: number;
}

export interface ClientReport {
  readonly ip: string;
  readonly ntpHits: number;
  readonly ntpDrops: number;
  readonly ntpInterval: number;
  readonly ntpLimitedInterval: number;
  readonly lastNtpAgo: number;
}

export interface ServerStatsReport {
  readonly values: readonly number[];
}

export interface ActivityReport {
  readonly online: number;
  readonly offline: number;
  readonly burstOnline: number;
  readonly burstOffline: number;
  readonly unresolved: number;
}

const KEY_TYPES: Readonly<Record<string, number>> = {
  MD5: 1, SHA1: 2, SHA256: 3, SHA384: 4, SHA512: 5, RMD160: 6,
};

function refIdOf(ip: string): number {
  return ipv4ToUint32(ip) ?? 0;
}

function wholeSecondsSince(sampleTime: number, nowSeconds: number): number {
  return Math.max(0, Math.floor(nowSeconds - Math.floor(sampleTime)));
}

export class ChronyDaemonView {
  constructor(
    private readonly service: LinuxChronyService,
    private readonly agent: NtpAgent,
  ) {}

  private nowSeconds(): number { return simulationNowMs() / 1000; }

  private associations(): NtpAssociation[] {
    return [...this.agent.getConfig().associations.values()].filter((a) => !a.ephemeral);
  }

  setCriteria(association: NtpAssociation, criteria: Parameters<NtpAgent['setSourceCriteria']>[1]): void {
    this.agent.setSourceCriteria(association.serverIp, criteria);
  }

  setOnline(association: NtpAssociation, online: boolean): void {
    this.agent.setSourceOnline(association.serverIp, online);
  }

  startBurst(association: NtpAssociation, good: number, total: number): void {
    this.agent.startBurst(association.serverIp, good, total);
  }

  reselect(): void { this.agent.reselectSources(); }

  resetSources(): void { this.agent.resetSources(); }

  clearClients(): void { this.agent.clearClientLog(); }

  findSource(ip: string): NtpAssociation | undefined {
    return this.associations().find((a) => a.serverIp === ip);
  }

  matching(address: string | null, mask: number | null): NtpAssociation[] {
    const all = this.associations();
    if (address === null) return all;
    const wanted = ipv4ToUint32(address);
    if (wanted === null) return [];
    const bits = mask ?? 0xffffffff;
    return all.filter((a) => ((ipv4ToUint32(a.serverIp) ?? 0) & bits) >>> 0 === (wanted & bits) >>> 0);
  }

  private stateOf(a: NtpAssociation): SourceState {
    if (a.preferred) return 'selected';
    if (a.selection === 'falseticker') return 'falseticker';
    if (a.selection === 'candidate') return 'unselected';
    if (a.selection === 'outlier') return 'selectable';
    return 'nonselectable';
  }

  sources(): SourceReport[] {
    const now = this.nowSeconds();
    return this.associations().map((a) => {
      const latest = a.statistics.latest();
      return {
        ip: a.serverIp,
        mode: a.mode === 'symmetric-active' ? 'peer' : 'client',
        state: this.stateOf(a),
        stratum: a.received === 0 || a.stratum >= 16 ? 0 : a.stratum,
        poll: a.hpoll,
        reachability: a.reach & 0xff,
        sinceSample: latest === null ? NO_ELAPSED : wholeSecondsSince(latest.time, now),
        latestMeasurement: latest?.offset ?? 0,
        originalLatestMeasurement: latest?.original ?? 0,
        latestMeasurementError: a.statistics.latestMeasurementError(),
      };
    });
  }

  sourcestats(): SourcestatsReport[] {
    const now = this.nowSeconds();
    return this.associations().map((a) => {
      const report = a.statistics.sourcestats(now);
      return {
        ip: a.serverIp,
        samples: report.samples,
        runs: report.runs,
        spanSeconds: report.spanSeconds,
        residualFrequencyPpm: report.residualFrequencyPpm,
        skewPpm: report.skewPpm,
        estimatedOffset: report.estimatedOffset,
        standardDeviation: report.standardDeviation,
      };
    });
  }

  private systemPeer(): NtpAssociation | undefined {
    return this.associations().find((a) => a.preferred);
  }

  private localReferenceActive(): boolean {
    const config = this.agent.getConfig();
    return config.serverMode && config.refIdentifier === 'LOCL' && this.systemPeer() === undefined;
  }

  tracking(): TrackingReport {
    const now = this.nowSeconds();
    const peer = this.systemPeer();
    const reference = this.agent.getReference();
    const system = this.agent.getConfig().system;
    if (peer !== undefined && this.agent.isSynced()) {
      const report = peer.statistics.sourcestats(now);
      return {
        referenceId: refIdOf(peer.serverIp),
        referenceName: peer.serverIp,
        stratum: this.agent.getStratum(),
        referenceTime: reference.referenceTime(),
        currentCorrection: -report.estimatedOffset,
        lastOffset: reference.lastOffset(),
        rmsOffset: reference.rmsOffset(),
        frequencyPpm: reference.frequency() * 1e6,
        residualFrequencyPpm: reference.residualFrequency() * 1e6,
        skewPpm: reference.skew() * 1e6,
        rootDelay: system.rootDelayMs / 1000,
        rootDispersion: this.agent.getRootDispersionMs() / 1000,
        updateInterval: reference.updateInterval(),
        leap: system.leap,
      };
    }
    const unsynchronised = !this.localReferenceActive();
    return {
      referenceId: unsynchronised ? 0 : LOCAL_REFERENCE_ID,
      referenceName: '',
      stratum: unsynchronised ? 0 : this.agent.getStratum(),
      referenceTime: unsynchronised ? 0 : now,
      currentCorrection: 0,
      lastOffset: reference.lastOffset(),
      rmsOffset: reference.rmsOffset(),
      frequencyPpm: 0,
      residualFrequencyPpm: 0,
      skewPpm: 0,
      rootDelay: unsynchronised ? UNSYNCHRONISED_ROOT : 0,
      rootDispersion: unsynchronised ? UNSYNCHRONISED_ROOT : 0,
      updateInterval: reference.updateInterval(),
      leap: unsynchronised ? 3 : 0,
    };
  }

  private optionString(a: NtpAssociation, effective: boolean): string {
    const authenticatedMajority = effective && a.keyId !== undefined
      && this.associations().some((other) => other.keyId === undefined && !other.noselect);
    const trust = a.trust || authenticatedMajority;
    const require = a.require || authenticatedMajority;
    return `${a.noselect ? 'N' : '-'}${a.prefer ? 'P' : '-'}${trust ? 'T' : '-'}${require ? 'R' : '-'}-`;
  }

  private selectState(a: NtpAssociation): string {
    if (a.noselect) return 'N';
    if (a.statistics.getSampleCount() === 0) return 'M';
    if (a.preferred) return '*';
    if (a.selection === 'falseticker') return 'x';
    if (a.selection === 'candidate') return '+';
    if (a.selection === 'outlier') return '-';
    if (a.reach === 0) return 'S';
    return 's';
  }

  selectData(): SelectReport[] {
    const now = this.nowSeconds();
    return this.associations().map((a) => {
      const selection = a.statistics.selection(now);
      return {
        ip: a.serverIp,
        stateChar: this.selectState(a),
        authenticated: a.keyId !== undefined,
        configuredOptions: this.optionString(a, false),
        effectiveOptions: this.optionString(a, true),
        lastSampleAgo: selection === null ? 0 : Math.max(0, Math.floor(selection.lastSampleAgo)),
        score: 1,
        low: selection?.offsetLow ?? 0,
        high: selection?.offsetHigh ?? 0,
        leap: a.received === 0 ? 3 : a.leap,
      };
    });
  }

  authData(): AuthReport[] {
    const authKeys = this.agent.getConfig().authKeys;
    return this.associations().map((a) => {
      const key = a.keyId !== undefined ? authKeys.get(a.keyId) : undefined;
      return {
        ip: a.serverIp,
        mode: key !== undefined ? 'SK' : '-',
        keyId: key !== undefined ? a.keyId! : 0,
        keyType: key !== undefined ? KEY_TYPES[key.algo.toUpperCase()] ?? 0 : 0,
        keyLength: key !== undefined
          ? (/^HEX:/i.test(key.key) ? ((key.key.length - 4) / 2) * 8 : key.key.length * 8) : 0,
      };
    });
  }

  ntpData(a: NtpAssociation): NtpDataReport {
    const response = a.response;
    const localIp = a.localIp ?? null;
    const heard = response !== null;
    const stratum = heard && a.stratum < 16 ? a.stratum : 0;
    const referenceId = heard && isValidIPv4(a.refId) ? refIdOf(a.refId) : 0;
    const tests = Number.parseInt(a.lastTests.replace(/ /g, ''), 2);
    return {
      remoteIp: a.serverIp,
      remotePort: 123,
      localIp: localIp ?? '[UNSPEC]',
      leap: heard ? a.leap : 0,
      version: heard ? response.version : 0,
      mode: heard ? { 'symmetric-active': 1, 'symmetric-passive': 2, server: 4 }[response.mode as string] ?? 0 : 0,
      stratum,
      poll: heard ? response.poll : 0,
      precision: heard ? response.precision : 0,
      rootDelay: heard ? a.rootDelayMs / 1000 : 0,
      rootDispersion: heard ? a.rootDispersionMs / 1000 : 0,
      referenceId,
      referenceName: stratum <= 1 && heard && !isValidIPv4(a.refId) ? a.refId : '',
      referenceTime: heard ? Number(a.refTimestamp >> 32n) - 2208988800 + Number(a.refTimestamp & 0xffffffffn) / 2 ** 32 : 0,
      offset: heard ? -(a.statistics.latest()?.original ?? 0) : 0,
      peerDelay: heard ? response.delayMs / 1000 : 0,
      peerDispersion: heard ? response.dispersionMs / 1000 : 0,
      responseTime: heard ? response.responseTimeMs / 1000 : 0,
      tests: Number.isNaN(tests) ? 0 : tests,
      interleaved: false,
      authenticated: heard && response.authenticated,
      transmitSource: heard ? 'D' : 'I',
      receiveSource: heard ? 'K' : 'I',
      totalTransmitted: a.sent,
      totalReceived: a.received,
      totalValid: a.validReceived,
      totalGood: a.goodReceived,
    };
  }

  serverStats(): ServerStatsReport {
    const c = this.agent.getCounters();
    return {
      values: [
        c.serverRequests, c.serverDropped, this.service.getCommandPackets(), 0, 0, 0, 0,
        c.serverAuthenticated, 0, 0, 0, 0, c.serverReplies, c.serverRequests, 0, 0, 0,
      ],
    };
  }

  clients(minimumHits: number): ClientReport[] {
    const now = simulationNowMs();
    const rows: ClientReport[] = [];
    for (const [ip, entry] of this.agent.getClientLog()) {
      if (entry.ntpHits < minimumHits) continue;
      rows.push({
        ip, ntpHits: entry.ntpHits, ntpDrops: entry.ntpDrops,
        ntpInterval: entry.intervalExponent, ntpLimitedInterval: entry.limitedIntervalExponent,
        lastNtpAgo: Math.max(0, Math.floor((now - entry.lastNtpMs) / 1000)),
      });
    }
    return rows;
  }

  activity(): ActivityReport {
    const all = this.associations();
    return {
      online: all.filter((a) => a.online && a.burst === 0).length,
      offline: all.filter((a) => !a.online && a.burst === 0).length,
      burstOnline: all.filter((a) => a.online && a.burst > 0).length,
      burstOffline: all.filter((a) => !a.online && a.burst > 0).length,
      unresolved: this.service.getConf().sources.filter((s) => !isValidIPv4(s.hote)).length,
    };
  }
}
