import { MACAddress, type EthernetFrame } from '../../../core/types';
import {
  HA_DEFAULTS, electPrimary,
  type HaCandidate, type HaConfiguration, type HaElectionReason,
  type HaHeartbeat, type HaPeer, type HaRole, type HaSyncedSession,
} from './HaTypes';

export const ETHERTYPE_FGCP = 0x8890;

export interface HaAgentDeps {
  readonly serial: () => string;
  readonly hostname: () => string;
  readonly now: () => number;
  readonly sendFrame: (iface: string, frame: EthernetFrame) => void;
  readonly interfaceMac: (iface: string) => MACAddress | undefined;
  readonly interfaceUp: (iface: string) => boolean;
  readonly configurationText: () => string;
  readonly applyConfiguration: (text: string) => void;
  readonly exportSessions: () => readonly HaSyncedSession[];
  readonly importSessions: (sessions: readonly HaSyncedSession[]) => void;
}

export interface HaElectionRecord {
  readonly at: number;
  readonly serial: string;
  readonly reason: HaElectionReason;
}

export class HaAgent {
  private config: HaConfiguration = HA_DEFAULTS;
  private currentRole: HaRole = 'standalone';
  private readonly peers = new Map<string, HaPeer>();
  private readonly electionRecords: HaElectionRecord[] = [];
  private startedAt: number;
  private uptimeBonusMs = 0;
  private lastMonitoredUp: number | null = null;
  private forcedFailover = false;

  constructor(private readonly deps: HaAgentDeps) {
    this.startedAt = deps.now();
  }

  configure(config: HaConfiguration): void {
    this.config = config;
    if (config.mode === 'standalone') {
      this.currentRole = 'standalone';
      this.peers.clear();
      return;
    }
    if (this.currentRole === 'standalone') this.currentRole = 'slave';
  }

  getConfiguration(): HaConfiguration { return this.config; }

  role(): HaRole { return this.currentRole; }

  serial(): string { return this.deps.serial(); }

  hostname(): string { return this.deps.hostname(); }

  resetUptime(): void {
    this.startedAt = this.deps.now();
    this.uptimeBonusMs = 0;
  }

  private noteMonitoredLoss(): void {
    const up = this.monitoredUp();
    if (this.lastMonitoredUp !== null && up < this.lastMonitoredUp) this.resetUptime();
    this.lastMonitoredUp = up;
  }

  requestSynchronisation(): void {
    if (this.config.mode === 'standalone') return;
    this.emitHeartbeat();
  }

  uptimeMs(): number { return this.deps.now() - this.startedAt + this.uptimeBonusMs; }

  advanceUptime(ms: number): void { this.uptimeBonusMs += ms; }

  forceFailover(): void { this.forcedFailover = true; }

  knownPeers(): readonly HaPeer[] { return Object.freeze([...this.peers.values()]); }

  elections(): readonly HaElectionRecord[] {
    return Object.freeze(this.electionRecords.slice(-2).reverse());
  }

  configurationDigest(): string {
    return digestOf(this.deps.configurationText());
  }

  monitoredUp(): number {
    return this.config.monitored.filter(iface => this.deps.interfaceUp(iface)).length;
  }

  tick(): void {
    if (this.config.mode === 'standalone') return;

    this.noteMonitoredLoss();

    this.emitHeartbeat();
    this.ageOutPeers();
    this.elect();
  }

  receive(frame: EthernetFrame): boolean {
    if (frame.etherType !== ETHERTYPE_FGCP) return false;

    const beat = frame.payload as HaHeartbeat | undefined;
    if (beat?.type !== 'fgcp-heartbeat') return false;
    if (this.config.mode === 'standalone') return true;
    if (beat.groupId !== this.config.groupId) return true;
    if (beat.groupName !== this.config.groupName) return true;
    if (beat.passwordDigest !== digestOf(this.config.password)) return true;
    if (beat.serial === this.deps.serial()) return true;

    this.peers.set(beat.serial, {
      serial: beat.serial,
      hostname: beat.hostname,
      priority: beat.priority,
      override: beat.override,
      monitoredUp: beat.monitoredUp,
      uptimeMs: beat.uptimeMs,
      role: beat.role,
      steppingDown: beat.steppingDown,
      configurationDigest: beat.configurationDigest,
      silentTicks: 0,
      lastSeenAt: this.deps.now(),
    });

    if (beat.role === 'master' && this.currentRole !== 'master') {
      this.deps.applyConfiguration(beat.configuration);
      if (this.config.sessionPickup && beat.sessionPickup) {
        this.deps.importSessions(beat.sessions);
      }
    }
    return true;
  }

  private emitHeartbeat(): void {
    const beat: HaHeartbeat = {
      type: 'fgcp-heartbeat',
      groupId: this.config.groupId,
      groupName: this.config.groupName,
      passwordDigest: digestOf(this.config.password),
      serial: this.deps.serial(),
      hostname: this.deps.hostname(),
      priority: this.config.priority,
      override: this.config.override,
      monitoredUp: this.monitoredUp(),
      uptimeMs: this.uptimeMs(),
      role: this.currentRole,
      configurationDigest: this.configurationDigest(),
      configuration: this.deps.configurationText(),
      sessionPickup: this.config.sessionPickup,
      steppingDown: this.forcedFailover,
      sessions: this.config.sessionPickup ? this.deps.exportSessions() : [],
    };

    for (const device of this.config.heartbeatDevices) {
      const source = this.deps.interfaceMac(device.iface);
      if (!source) continue;
      this.deps.sendFrame(device.iface, {
        srcMAC: source,
        dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_FGCP,
        payload: beat,
      });
    }
  }

  private ageOutPeers(): void {
    for (const [serial, peer] of [...this.peers]) {
      peer.silentTicks += 1;
      if (peer.silentTicks > this.config.lostThreshold) this.peers.delete(serial);
    }
  }

  private elect(): void {
    const mine: HaCandidate = {
      serial: this.deps.serial(),
      priority: this.config.priority,
      monitoredUp: this.monitoredUp(),
      uptimeMs: this.uptimeMs(),
    };
    const candidates: HaCandidate[] = [mine];
    for (const peer of this.peers.values()) {
      candidates.push({
        serial: peer.serial,
        priority: peer.priority,
        monitoredUp: peer.monitoredUp,
        uptimeMs: peer.uptimeMs,
      });
    }

    const steppingDown = new Set<string>();
    if (this.forcedFailover) steppingDown.add(mine.serial);
    for (const peer of this.peers.values()) {
      if (peer.steppingDown) steppingDown.add(peer.serial);
    }

    const standing = candidates.filter(c => !steppingDown.has(c.serial));
    const eligible = standing.length > 0 ? standing : candidates;

    const outcome = this.incumbentKeepsRole(eligible)
      ?? electPrimary(eligible, this.config.override);

    this.settleRole(outcome.winner, outcome.reason);
  }

  private incumbentKeepsRole(
    candidates: readonly HaCandidate[],
  ): { winner: string; reason: HaElectionReason } | null {
    if (this.config.override || candidates.length < 2) return null;

    const claiming = candidates.filter(candidate => this.claimsMaster(candidate.serial));
    if (claiming.length !== 1) return null;

    const incumbent = claiming[0];
    const contest = electPrimary(candidates, false);
    if (contest.winner === incumbent.serial) {
      return { winner: incumbent.serial, reason: contest.reason };
    }
    if (contest.reason === 'monitored-interfaces' || contest.reason === 'uptime') {
      return null;
    }
    return { winner: incumbent.serial, reason: 'uptime' };
  }

  private claimsMaster(serial: string): boolean {
    if (serial === this.deps.serial()) return this.currentRole === 'master';
    return this.peers.get(serial)?.role === 'master';
  }

  private settleRole(winner: string, reason: HaElectionReason): void {
    const nextRole: HaRole = winner === this.deps.serial() ? 'master' : 'slave';
    this.currentRole = nextRole;
    if (nextRole !== 'master') return;

    const last = this.electionRecords[this.electionRecords.length - 1];
    if (last && last.serial === winner && last.reason === reason) return;

    this.electionRecords.push({ at: this.deps.now(), serial: winner, reason });
  }
}

export function digestOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
