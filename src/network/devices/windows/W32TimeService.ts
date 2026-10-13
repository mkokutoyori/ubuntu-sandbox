import { simulationNowMs } from '@/network/core/SystemClock';

import type { NtpAgent } from '../../ntp/NtpAgent';
import { isValidIPv4 } from '../../core/ip';
import {
  W32TimeRegistry, type W32TimeRegistryPort,
  W32TIME_PARAMETERS_KEY, W32TIME_CONFIG_KEY, W32TIME_NTP_CLIENT_KEY, W32TIME_NTP_SERVER_KEY,
} from './W32TimeRegistry';

export type W32TimeType = 'NoSync' | 'NTP' | 'NT5DS' | 'AllSync';

export const FLAG_SPECIAL_INTERVAL = 0x1;
export const FLAG_FALLBACK_ONLY = 0x2;
export const FLAG_SYMMETRIC_ACTIVE = 0x4;
export const FLAG_CLIENT = 0x8;
const VALID_FLAGS = 0xf;

export interface W32Peer {
  readonly text: string;
  readonly host: string;
  readonly flags: number;
  readonly mode: 'client' | 'peer';
  readonly origin: 'manual' | 'domain';
  readonly address: string | null;
}

export interface W32TimeHost {
  ntp(): NtpAgent;
  readonly registry: W32TimeRegistryPort;
  isServerEdition(): boolean;
  isDomainMember(): boolean;
  domainSource(): { readonly name: string; readonly address: string } | null;
  resolve(name: string): string | null;
  isServiceRunning(): boolean;
  writeEvent(id: number, level: 'Information' | 'Warning' | 'Error', message: string): void;
  onSynchronised(listener: (peerAddress: string) => void): () => void;
}

export interface W32Result {
  readonly ok: boolean;
  readonly message?: string;
}

const SYNC_FROM_FLAGS: Readonly<Record<string, W32TimeType>> = {
  manual: 'NTP', domhier: 'NT5DS', no: 'NoSync', all: 'AllSync',
};

const CONFIG_SWITCHES: Readonly<Record<string, readonly [key: string, name: string]>> = {
  announceflags: [W32TIME_CONFIG_KEY, 'AnnounceFlags'],
  eventlogflags: [W32TIME_CONFIG_KEY, 'EventLogFlags'],
  frequencycorrectrate: [W32TIME_CONFIG_KEY, 'FrequencyCorrectRate'],
  largephaseoffset: [W32TIME_CONFIG_KEY, 'LargePhaseOffset'],
  lastclockrate: [W32TIME_CONFIG_KEY, 'LastClockRate'],
  localclockdispersion: [W32TIME_CONFIG_KEY, 'LocalClockDispersion'],
  maxallowedphaseoffset: [W32TIME_CONFIG_KEY, 'MaxAllowedPhaseOffset'],
  maxnegphasecorrection: [W32TIME_CONFIG_KEY, 'MaxNegPhaseCorrection'],
  maxposphasecorrection: [W32TIME_CONFIG_KEY, 'MaxPosPhaseCorrection'],
  maxpollinterval: [W32TIME_CONFIG_KEY, 'MaxPollInterval'],
  minpollinterval: [W32TIME_CONFIG_KEY, 'MinPollInterval'],
  phasecorrectrate: [W32TIME_CONFIG_KEY, 'PhaseCorrectRate'],
  spikewatchperiod: [W32TIME_CONFIG_KEY, 'SpikeWatchPeriod'],
  updateinterval: [W32TIME_CONFIG_KEY, 'UpdateInterval'],
};

export function parseNtpServerText(text: string): Array<{ host: string; flags: number; text: string } | { invalid: string }> {
  const out: Array<{ host: string; flags: number; text: string } | { invalid: string }> = [];
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const [host, flagText] = token.split(',');
    let flags = 0;
    if (flagText !== undefined) {
      const parsed = /^0x[0-9a-f]+$/i.test(flagText) ? parseInt(flagText, 16) : /^\d+$/.test(flagText) ? parseInt(flagText, 10) : NaN;
      if (Number.isNaN(parsed) || parsed > VALID_FLAGS) {
        out.push({ invalid: flagText });
        continue;
      }
      flags = parsed;
    }
    out.push({ host, flags, text: token });
  }
  return out;
}

export function modeOfFlags(flags: number): 'client' | 'peer' {
  return flags & FLAG_SYMMETRIC_ACTIVE ? 'peer' : 'client';
}

export class W32TimeService {
  readonly registry: W32TimeRegistry;
  private startedAt = simulationNowMs();
  private peers: W32Peer[] = [];
  private unsubscribe: (() => void) | null = null;
  private lastAnnouncedPeer: string | null = null;

  constructor(private readonly host: W32TimeHost) {
    this.registry = new W32TimeRegistry(host.registry);
    this.registry.seed({ serverEdition: host.isServerEdition(), domainMember: host.isDomainMember() });
  }

  getUptimeSec(): number { return Math.max(0, Math.floor((simulationNowMs() - this.startedAt) / 1000)); }

  getType(): W32TimeType {
    const text = this.registry.readText(W32TIME_PARAMETERS_KEY, 'Type', 'NTP').toLowerCase();
    return text === 'nosync' ? 'NoSync' : text === 'nt5ds' ? 'NT5DS' : text === 'allsync' ? 'AllSync' : 'NTP';
  }

  setType(type: W32TimeType): void {
    this.registry.write(W32TIME_PARAMETERS_KEY, 'Type', 'String', type);
  }

  getPeers(): readonly W32Peer[] { return this.peers; }

  getNtpServerText(): string { return this.registry.readText(W32TIME_PARAMETERS_KEY, 'NtpServer'); }

  isReliable(): boolean {
    return (this.registry.readNumber(W32TIME_CONFIG_KEY, 'AnnounceFlags', 10) & 0x4) !== 0;
  }

  isClientEnabled(): boolean { return this.registry.readNumber(W32TIME_NTP_CLIENT_KEY, 'Enabled', 1) !== 0; }

  isServerEnabled(): boolean { return this.registry.readNumber(W32TIME_NTP_SERVER_KEY, 'Enabled', 0) !== 0; }

  configure(options: {
    manualPeerList?: string;
    syncFromFlags?: string;
    reliable?: string;
    switches: ReadonlyMap<string, string>;
    update: boolean;
  }): W32Result {
    if (options.manualPeerList !== undefined) {
      const parsed = parseNtpServerText(options.manualPeerList);
      const bad = parsed.find((entry): entry is { invalid: string } => 'invalid' in entry);
      if (bad !== undefined) return { ok: false, message: 'The following error occurred: The parameter is incorrect. (0x80070057)' };
      this.registry.write(W32TIME_PARAMETERS_KEY, 'NtpServer', 'String', options.manualPeerList.trim());
    }
    if (options.syncFromFlags !== undefined) {
      const tokens = options.syncFromFlags.toLowerCase().split(',').map((token) => token.trim());
      if (tokens.some((token) => SYNC_FROM_FLAGS[token] === undefined)) {
        return { ok: false, message: 'The following error occurred: The parameter is incorrect. (0x80070057)' };
      }
      const set = new Set(tokens);
      const type: W32TimeType = set.has('all') || (set.has('manual') && set.has('domhier')) ? 'AllSync'
        : set.has('manual') ? 'NTP' : set.has('domhier') ? 'NT5DS' : 'NoSync';
      this.setType(type);
    }
    if (options.reliable !== undefined) {
      this.registry.writeNumber(W32TIME_CONFIG_KEY, 'AnnounceFlags', /^(yes|true|1)$/i.test(options.reliable) ? 5 : 10);
    }
    for (const [name, value] of options.switches) {
      const target = CONFIG_SWITCHES[name];
      if (target === undefined || !/^-?\d+$/.test(value)) return { ok: false, message: 'The following error occurred: The parameter is incorrect. (0x80070057)' };
      this.registry.writeNumber(target[0], target[1], Number(value));
    }
    if (options.update) this.applyConfiguration();
    return { ok: true };
  }

  private desiredPeers(): W32Peer[] {
    const type = this.getType();
    const out: W32Peer[] = [];
    if (type === 'NT5DS' || type === 'AllSync') {
      const source = this.host.domainSource();
      if (source !== null) {
        out.push({
          text: source.name, host: source.name, flags: FLAG_SPECIAL_INTERVAL | FLAG_CLIENT,
          mode: 'client', origin: 'domain', address: source.address,
        });
      } else if (this.host.isDomainMember()) {
        this.host.writeEvent(134, 'Warning',
          'NtpClient was unable to set a domain peer to use as a time source because of discovery error. '
          + 'NtpClient will try again in 15 minutes and double the reattempt interval thereafter. '
          + 'The error was: The entry is not found. (0x800706E1)');
      }
    }
    if (type === 'NTP' || type === 'AllSync') {
      for (const entry of parseNtpServerText(this.getNtpServerText())) {
        if ('invalid' in entry) continue;
        const address = isValidIPv4(entry.host) ? entry.host : this.host.resolve(entry.host);
        if (address === null) {
          this.host.writeEvent(129, 'Warning',
            `NtpClient was unable to set a manual peer to use as a time source because of DNS resolution error on '${entry.host}'. `
            + 'NtpClient will try again in 15 minutes and double the reattempt interval thereafter. '
            + 'The error was: No such host is known. (0x80072AF9)');
        }
        out.push({ text: entry.text, host: entry.host, flags: entry.flags, mode: modeOfFlags(entry.flags), origin: 'manual', address });
      }
    }
    return out;
  }

  applyConfiguration(): void {
    const agent = this.host.ntp();
    const config = (name: string, fallback: number): number => this.registry.readNumber(W32TIME_CONFIG_KEY, name, fallback);
    const lastRate = config('LastClockRate', 156250);
    agent.setReglagesDiscipline({
      seuilSautMs: config('MaxAllowedPhaseOffset', 1) * 1000,
      seuilPaniqueMs: Math.max(config('MaxPosPhaseCorrection', 54000), config('MaxNegPhaseCorrection', 54000)) * 1000,
      spikeThresholdMs: config('LargePhaseOffset', 50000000) / 10000,
      spikeWatchMs: config('SpikeWatchPeriod', 90) * 1000,
      slewRatePpm: ((lastRate - config('MaxClockRate', 155860)) / lastRate) * 1e6,
      reinitialiserAssociationsAuSaut: false,
    });
    agent.setClientAdmission(() => this.isServerEnabled());
    for (const ip of [...agent.getConfig().associations.keys()]) agent.removeServer(ip);
    this.peers = this.isClientEnabled() && this.host.isServiceRunning() ? this.desiredPeers() : [];
    const minPoll = config('MinPollInterval', 6);
    const maxPoll = Math.max(minPoll, config('MaxPollInterval', 10));
    const special = this.registry.readNumber(W32TIME_NTP_CLIENT_KEY, 'SpecialPollInterval', 604800);
    for (const peer of this.peers) {
      if (peer.address === null) continue;
      const options = { minpoll: minPoll, maxpoll: maxPoll };
      if (peer.mode === 'peer') agent.addPeer(peer.address, false, undefined, options);
      else agent.addServer(peer.address, false, undefined, 'ntp', options);
      agent.setSourceCriteria(peer.address, {
        fixedPollSec: peer.flags & FLAG_SPECIAL_INTERVAL ? special : undefined,
        fallbackOnly: (peer.flags & FLAG_FALLBACK_ONLY) !== 0,
      });
    }
    agent.setEnabled(this.host.isServiceRunning());
    this.watchSynchronisation();
  }

  private watchSynchronisation(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.host.onSynchronised((address) => {
      const peer = this.peers.find((candidate) => candidate.address === address);
      if (peer === undefined || this.lastAnnouncedPeer === address) return;
      this.lastAnnouncedPeer = address;
      const origin = peer.origin === 'domain' ? 'd' : 'm';
      const description = `${peer.host} (ntp.${origin}|0x${peer.flags.toString(16)}|0.0.0.0:123->${address}:123)`;
      this.host.writeEvent(37, 'Information', `The time provider NtpClient is currently receiving valid time data from ${description}.`);
      this.host.writeEvent(35, 'Information', `The time service is now synchronizing the system time with the time source ${description}.`);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastAnnouncedPeer = null;
    this.peers = [];
    const agent = this.host.ntp();
    for (const ip of [...agent.getConfig().associations.keys()]) agent.removeServer(ip);
    agent.setEnabled(false);
  }

  currentPeer(): W32Peer | undefined {
    const system = this.host.ntp().getConfig().system.peerIp;
    return system === null ? undefined : this.peers.find((peer) => peer.address === system);
  }

  sourceText(): string {
    const agent = this.host.ntp();
    const peer = this.currentPeer();
    if (peer !== undefined && agent.isSynced()) return peer.origin === 'domain' ? peer.host : peer.text;
    const config = agent.getConfig();
    if (config.refIdentifier === 'LOCL' && agent.isSynced()) return 'Local CMOS Clock';
    return 'Local CMOS Clock';
  }

  resync(options: { force: boolean; rediscover: boolean }): W32Result {
    if (!this.host.isServiceRunning()) {
      return { ok: false, message: 'The following error occurred: The service has not been started. (0x80070426)' };
    }
    if (options.rediscover || options.force) this.applyConfiguration();
    const agent = this.host.ntp();
    if (this.peers.filter((peer) => peer.address !== null).length === 0) {
      return { ok: false, message: 'The computer did not resync because no time data was available.' };
    }
    agent.pollAll();
    const offset = agent.bestMeasuredOffsetMs();
    const limit = Math.max(
      this.registry.readNumber(W32TIME_CONFIG_KEY, 'MaxPosPhaseCorrection', 54000),
      this.registry.readNumber(W32TIME_CONFIG_KEY, 'MaxNegPhaseCorrection', 54000)) * 1000;
    if (offset !== null && Math.abs(offset) > limit) {
      return { ok: false, message: 'The computer did not resync because the required time change was too big.' };
    }
    if (options.force) agent.forcerSaut();
    return { ok: true };
  }
}
