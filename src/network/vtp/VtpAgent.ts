import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type VtpConfig, type VtpFrame, type VtpMode, type VtpVersion, type VtpVlanEntry,
  type VtpMstRegionPayload,
  createDefaultVtpConfig, hashPassword,
  ETHERTYPE_VTP, VTP_MULTICAST_MAC,
} from './types';
import { MACAddress, type EthernetFrame } from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import { Logger } from '../core/Logger';

export interface VtpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendOnLink(request: LinkSendRequest): boolean;
  vtpListVlans(): VtpVlanEntry[];
  vtpApplyVlans(vlans: VtpVlanEntry[]): { added: number[]; removed: number[] };
  vtpIsTrunkPort(portName: string): boolean;
  vtpLocalInterest(): number[];
  /** Updater Identity for the wire (real Cisco: management interface IP,
   *  or failing that the lowest-numbered active VLAN SVI) — '0.0.0.0' if
   *  none is configured. */
  vtpUpdaterIdentity(): string;
  vtpGetMstRegion(): VtpMstRegionPayload;
  vtpApplyMstRegion(region: VtpMstRegionPayload): void;
}

const PRUNING_ELIGIBLE_MIN = 2;
const PRUNING_ELIGIBLE_MAX = 1001;
const STANDARD_VLAN_MAX = 1005;
/** Real Subset Advertisements carry roughly this many VLANs per frame;
 *  fragmenting at the same order of magnitude keeps `followers`/
 *  `sequenceNumber` exercised by any lab whose VLAN base is unusually
 *  large, without changing behavior for the common (single-lot) case. */
const VLANS_PER_SUBSET = 40;

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class VtpAgent extends ReactiveAgentBase {
  private config: VtpConfig;
  private readonly advertising = new Set<string>();
  private lastSummaryRevision: number | null = null;
  private lastSummaryDomain: string | null = null;
  private pendingSubsetTotal = 1;
  private readonly pendingSubsetParts = new Map<number, VtpVlanEntry[]>();
  private readonly peerInterest = new Map<string, Set<number>>();
  private knownPrimary: { updater: string; revision: number } | null = null;
  private hasSyncedDatabase = false;
  private lastMstSummaryRevision: number | null = null;
  private lastMstSummaryDomain: string | null = null;
  private hasSyncedMstDatabase = false;

  constructor(
    private readonly host: VtpHost,
    getBus: () => IEventBus,
    systemMac: string,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
    this.config = createDefaultVtpConfig(systemMac);
  }

  getConfig(): Readonly<VtpConfig> { return this.config; }

  setMode(mode: VtpMode): void {
    if (this.config.mode === mode) return;
    const old = this.config.mode;
    this.config.mode = mode;
    this.getBus().publish({
      topic: 'vtp.mode.changed',
      payload: { deviceId: this.host.id, hostname: this.host.getHostname(), oldMode: old, newMode: mode },
    });
    if (mode === 'transparent') this.config.revision = 0;
    if (mode === 'server' && this.config.domain) this.advertiseSummary('config-change');
    if ((mode === 'server' || mode === 'client') && this.config.domain) {
      this.requestSyncOnTrunks('config-change');
    }
  }

  setDomain(name: string): void {
    if (this.config.domain === name) return;
    const old = this.config.domain;
    this.config.domain = name;
    this.config.revision = 0;
    this.hasSyncedDatabase = false;
    this.getBus().publish({
      topic: 'vtp.domain.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        oldDomain: old, newDomain: name, version: this.config.version,
      },
    });
    if (this.config.mode === 'server') this.advertiseSummary('config-change');
    if (this.config.mode === 'server' || this.config.mode === 'client') {
      this.requestSyncOnTrunks('config-change');
    }
  }

  setPassword(pw: string): void {
    this.config.password = pw;
  }

  setVersion(v: VtpVersion): void {
    this.config.version = v;
  }

  setPruning(on: boolean): void {
    if (this.config.pruning === on) return;
    this.config.pruning = on;
    if (on) this.broadcastInterest();
  }

  allowsExtendedRangeVlans(): boolean {
    return this.config.mode === 'transparent' || this.config.mode === 'off' || this.config.version === 3;
  }

  isVlanPruned(portName: string, vlan: number): boolean {
    if (!this.config.pruning) return false;
    if (vlan < PRUNING_ELIGIBLE_MIN || vlan > PRUNING_ELIGIBLE_MAX) return false;
    const peer = this.peerInterest.get(portName);
    if (!peer) return false;
    return !peer.has(vlan);
  }

  bumpRevision(): void {
    if (this.config.mode !== 'server' || !this.config.domain) return;
    this.config.revision += 1;
    this.config.lastUpdaterIdentity = this.host.vtpUpdaterIdentity();
    this.config.lastUpdateTimestamp = Date.now();
    this.advertiseSummary('local-vlan-change');
  }

  onLocalVlanChange(): void {
    this.bumpRevision();
  }

  onLocalMstChange(): void {
    if (this.config.mode !== 'server' || !this.config.domain || this.config.version !== 3) return;
    this.config.mstDatabaseRevision += 1;
    this.advertiseMstDatabase('local-mst-change');
  }

  runningConfigGlobalLines(): string[] {
    const out: string[] = [];
    if (this.config.domain) out.push(`vtp domain ${this.config.domain}`);
    if (this.config.mode !== 'server') out.push(`vtp mode ${this.config.mode}`);
    if (this.config.version !== 1) out.push(`vtp version ${this.config.version}`);
    if (this.config.password) out.push(`vtp password ${this.config.password}`);
    if (this.config.pruning) out.push('vtp pruning');
    return out;
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    if (this.config.mode === 'off') return;
    const payload = frame.payload as VtpFrame | undefined;
    if (!payload || payload.type !== 'vtp') return;

    if (payload.messageType === 'join') {
      if (this.host.vtpIsTrunkPort(portName)) this.handleJoin(portName, payload);
      return;
    }

    if (this.config.mode === 'transparent') {
      this.forwardOnTrunks(portName, frame);
      return;
    }
    if (!this.host.vtpIsTrunkPort(portName)) return;

    let accepted = true;
    let reject: string | undefined;
    if (this.config.domain && payload.domain !== this.config.domain) {
      accepted = false;
      reject = 'domain-mismatch';
    } else if (this.config.domain && payload.passwordHash !== hashPassword(payload.domain, this.config.password, payload.revision)) {
      accepted = false;
      reject = 'password-mismatch';
    }

    this.getBus().publish({
      topic: 'vtp.frame.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        fromDomain: payload.domain,
        fromRevision: payload.revision,
        accepted, rejectReason: reject,
      },
    });
    if (!accepted) return;

    if (!this.config.domain && payload.domain) {
      this.config.domain = payload.domain;
      this.getBus().publish({
        topic: 'vtp.domain.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          oldDomain: '', newDomain: payload.domain, version: this.config.version,
        },
      });
    }

    if (this.config.mode !== 'server' && this.config.mode !== 'client') return;

    if (payload.database === 'mst') {
      this.handleMstFrame(portName, payload);
      return;
    }

    if (payload.messageType === 'summary') {
      if (this.lastSummaryDomain !== payload.domain || this.lastSummaryRevision !== payload.revision) {
        this.pendingSubsetParts.clear();
      }
      this.lastSummaryDomain = payload.domain;
      this.lastSummaryRevision = payload.revision;
      this.pendingSubsetTotal = payload.followers ?? 1;
      if (this.config.version === 3 && payload.primaryClaim) {
        this.considerPrimaryClaim(payload.primaryClaim);
      }
      return;
    }

    if (payload.messageType === 'request') {
      this.handleRequest(portName);
      return;
    }

    if (payload.messageType !== 'subset') return;

    if (this.lastSummaryDomain !== payload.domain || this.lastSummaryRevision !== payload.revision) {
      Logger.warn(this.host.id, 'vtp:orphan-subset',
        `${this.host.name}: ignoring orphan Subset Advertisement (rev ${payload.revision}, no matching Summary) on ${portName}`);
      return;
    }

    // Buffer fragments until every one declared by the matching Summary's
    // `followers` count has arrived, then apply the assembled diff exactly
    // once — applying a partial lot on its own would make vtpApplyVlans
    // (a full-database diff) delete every VLAN not yet received.
    this.pendingSubsetParts.set(payload.sequenceNumber ?? 1, payload.vlans);
    if (this.pendingSubsetParts.size < this.pendingSubsetTotal) return;
    const combined = [...this.pendingSubsetParts.keys()].sort((a, b) => a - b)
      .flatMap(seq => this.pendingSubsetParts.get(seq)!);
    this.pendingSubsetParts.clear();

    const isFreshJoin = this.config.mode === 'client' && !this.hasSyncedDatabase;
    if (payload.revision > this.config.revision || (isFreshJoin && payload.revision === this.config.revision)) {
      const oldRev = this.config.revision;
      const result = this.host.vtpApplyVlans(this.filterVlansForVersion(combined));
      this.config.revision = payload.revision;
      this.config.lastUpdaterIdentity = payload.updater;
      this.config.lastUpdateTimestamp = payload.updateTimestamp;
      this.hasSyncedDatabase = true;
      this.getBus().publish({
        topic: 'vtp.db.synced',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName,
          oldRevision: oldRev, newRevision: payload.revision,
          vlansAdded: result.added, vlansRemoved: result.removed,
        },
      });
      Logger.info(this.host.id, 'vtp:sync',
        `${this.host.name}: VTP db ← ${payload.domain} rev ${payload.revision} on ${portName}`);
      if (this.config.mode === 'server') this.advertiseSummary('relay');
    }
  }

  private handleMstFrame(portName: string, payload: VtpFrame): void {
    if (this.config.version !== 3) return;

    if (payload.messageType === 'summary') {
      if (this.lastMstSummaryDomain !== payload.domain || this.lastMstSummaryRevision !== payload.revision) {
        this.lastMstSummaryDomain = payload.domain;
        this.lastMstSummaryRevision = payload.revision;
      }
      return;
    }

    if (payload.messageType !== 'subset' || !payload.mstRegion) return;

    if (this.lastMstSummaryDomain !== payload.domain || this.lastMstSummaryRevision !== payload.revision) {
      Logger.warn(this.host.id, 'vtp:orphan-mst-subset',
        `${this.host.name}: ignoring orphan MST Subset Advertisement (rev ${payload.revision}, no matching Summary) on ${portName}`);
      return;
    }

    const isFreshJoin = this.config.mode === 'client' && !this.hasSyncedMstDatabase;
    if (payload.revision > this.config.mstDatabaseRevision || (isFreshJoin && payload.revision === this.config.mstDatabaseRevision)) {
      const oldRev = this.config.mstDatabaseRevision;
      this.host.vtpApplyMstRegion(payload.mstRegion);
      this.config.mstDatabaseRevision = payload.revision;
      this.hasSyncedMstDatabase = true;
      this.getBus().publish({
        topic: 'vtp.mst.synced',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName,
          oldRevision: oldRev, newRevision: payload.revision,
          mstName: payload.mstRegion.name,
        },
      });
      Logger.info(this.host.id, 'vtp:mst-sync',
        `${this.host.name}: VTP MST db ← ${payload.domain} rev ${payload.revision} on ${portName}`);
      if (this.config.mode === 'server') this.advertiseMstDatabase('relay');
    }
  }

  private handleRequest(portName: string): void {
    if (this.config.mode !== 'server' || !this.config.domain) return;
    this.sendSummaryAndSubset(portName, 'request-reply');
    if (this.config.version === 3) this.advertiseMstDatabase('request-reply', portName);
  }

  becomePrimary(force: boolean): { ok: boolean; message: string } {
    if (this.config.version !== 3) {
      return { ok: false, message: '% VTP Primary Server election requires VTP version 3' };
    }
    if (this.config.mode !== 'server') {
      return { ok: false, message: '% This device is not a VTP Server' };
    }
    if (this.knownPrimary && this.knownPrimary.updater !== this.host.id
        && this.knownPrimary.revision >= this.config.revision && !force) {
      return {
        ok: false,
        message: '% Conflict: a Primary Server with an equal or higher revision already exists. Use "force" to override',
      };
    }
    this.knownPrimary = { updater: this.host.id, revision: this.config.revision };
    this.config.primaryServer = true;
    this.broadcastPrimaryClaim(force);
    return {
      ok: true,
      message: `VTP Primary Server election in progress...\n${this.host.name} is now the Primary Server for domain ${this.config.domain}`,
    };
  }

  private considerPrimaryClaim(claim: { updater: string; revision: number; forced: boolean }): void {
    if (this.knownPrimary && this.knownPrimary.updater === claim.updater
        && this.knownPrimary.revision === claim.revision) return;
    const accept = !this.knownPrimary
      || claim.revision > this.knownPrimary.revision
      || (claim.forced && claim.revision >= this.knownPrimary.revision);
    if (!accept) return;
    this.knownPrimary = { updater: claim.updater, revision: claim.revision };
    this.config.primaryServer = claim.updater === this.host.id;
  }

  private broadcastPrimaryClaim(forced: boolean): void {
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.sendPrimaryClaim(name, forced);
    }
  }

  private sendPrimaryClaim(portName: string, forced: boolean): void {
    const port = this.host.getPort(portName);
    if (!port || !this.knownPrimary) return;
    const payload: VtpFrame = {
      type: 'vtp', version: this.config.version, messageType: 'summary',
      domain: this.config.domain, revision: this.config.revision,
      updater: this.config.lastUpdaterIdentity,
      updateTimestamp: this.config.lastUpdateTimestamp,
      passwordHash: hashPassword(this.config.domain, this.config.password, this.config.revision),
      vlans: [],
      primaryClaim: { ...this.knownPrimary, forced },
    };
    this.host.sendOnLink({
      iface: portName,
      destination: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload,
    });
  }

  private handleJoin(portName: string, payload: VtpFrame): void {
    const incoming = new Set(payload.interestVlans ?? []);
    const prev = this.peerInterest.get(portName);
    if (prev && sameSet(prev, incoming)) return;
    this.peerInterest.set(portName, incoming);
    if (this.config.pruning) this.broadcastInterest(portName);
  }

  private filterVlansForVersion(vlans: VtpVlanEntry[]): VtpVlanEntry[] {
    if (this.config.version === 3) return vlans;
    return vlans.filter(v => v.id <= STANDARD_VLAN_MAX);
  }

  private aggregatedInterest(excludePort?: string): Set<number> {
    const out = new Set<number>(this.host.vtpLocalInterest());
    for (const [port, set] of this.peerInterest) {
      if (port === excludePort) continue;
      for (const v of set) out.add(v);
    }
    return out;
  }

  private broadcastInterest(excludePort?: string): void {
    if (!this.config.pruning) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (name === excludePort) continue;
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.sendJoin(name);
    }
  }

  private sendJoin(portName: string): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    const interest = this.aggregatedInterest(portName);
    const payload: VtpFrame = {
      type: 'vtp', version: this.config.version,
      messageType: 'join',
      domain: this.config.domain,
      revision: this.config.revision,
      updater: this.config.lastUpdaterIdentity,
      updateTimestamp: this.config.lastUpdateTimestamp,
      passwordHash: '',
      vlans: [],
      interestVlans: [...interest],
    };
    this.host.sendOnLink({
      iface: portName,
      destination: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload,
    });
  }

  advertiseAllTrunks(reason: 'periodic' | 'config-change' | 'local-vlan-change' | 'relay' | 'request-reply'): void {
    if (!this.config.enabled) return;
    if (this.config.mode !== 'server' || !this.config.domain) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.sendSummaryAndSubset(name, reason);
    }
  }

  private advertiseSummary(reason: 'config-change' | 'local-vlan-change' | 'relay'): void {
    this.advertiseAllTrunks(reason);
  }

  private requestSyncOnTrunks(reason: string): void {
    if (!this.config.enabled || !this.config.domain) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.sendVtpFrame(name, 'request', [], reason);
    }
  }

  onTrunkModeChanged(portName: string): void {
    if (!this.config.enabled) return;
    if (!this.host.vtpIsTrunkPort(portName)) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    if (this.config.pruning) this.sendJoin(portName);
    if (!this.config.domain) return;
    if (this.config.mode === 'server') {
      this.sendSummaryAndSubset(portName, 'trunk-up');
      if (this.config.version === 3) this.sendMstSummaryAndSubset(portName, 'trunk-up');
      this.sendVtpFrame(portName, 'request', [], 'trunk-up');
    } else if (this.config.mode === 'client') {
      this.sendVtpFrame(portName, 'request', [], 'trunk-up');
    }
  }

  private sendSummaryAndSubset(portName: string, reason: string): void {
    if (this.advertising.has(portName)) return;
    const port = this.host.getPort(portName);
    if (!port) return;
    this.advertising.add(portName);
    try {
      const lots = chunk(this.filterVlansForVersion(this.host.vtpListVlans()), VLANS_PER_SUBSET);
      const followers = Math.max(1, lots.length);
      this.sendVtpFrame(portName, 'summary', [], reason, { followers });
      if (lots.length === 0) {
        this.sendVtpFrame(portName, 'subset', [], reason, { sequenceNumber: 1 });
      } else {
        lots.forEach((lot, i) => {
          this.sendVtpFrame(portName, 'subset', lot, reason, { sequenceNumber: i + 1 });
        });
      }
    } finally {
      this.advertising.delete(portName);
    }
  }

  private sendVtpFrame(
    portName: string,
    messageType: 'summary' | 'subset' | 'request',
    vlans: VtpVlanEntry[],
    reason: string,
    fragment?: { followers?: number; sequenceNumber?: number },
    mst?: { revision: number; region?: VtpMstRegionPayload },
  ): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    const revision = mst ? mst.revision : this.config.revision;
    const payload: VtpFrame = {
      type: 'vtp', version: this.config.version,
      messageType,
      domain: this.config.domain,
      revision,
      updater: this.config.lastUpdaterIdentity,
      updateTimestamp: this.config.lastUpdateTimestamp,
      passwordHash: hashPassword(this.config.domain, this.config.password, revision),
      vlans,
      ...(mst ? { database: 'mst' as const, ...(mst.region ? { mstRegion: mst.region } : {}) } : {}),
      ...(messageType === 'summary' ? { followers: fragment?.followers ?? 1 } : {}),
      ...(messageType === 'subset' ? { sequenceNumber: fragment?.sequenceNumber ?? 1 } : {}),
      ...(messageType === 'summary' && this.knownPrimary && !mst
        ? { primaryClaim: { ...this.knownPrimary, forced: false } }
        : {}),
    };
    this.host.sendOnLink({
      iface: portName,
      destination: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload,
    });
    this.getBus().publish({
      topic: 'vtp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        messageType: `${messageType}:${reason}`,
        domain: this.config.domain,
        revision,
      },
    });
  }

  private sendMstSummaryAndSubset(portName: string, reason: string): void {
    if (this.advertising.has(portName)) return;
    const port = this.host.getPort(portName);
    if (!port) return;
    this.advertising.add(portName);
    try {
      const region = this.host.vtpGetMstRegion();
      const revision = this.config.mstDatabaseRevision;
      this.sendVtpFrame(portName, 'summary', [], reason, { followers: 1 }, { revision });
      this.sendVtpFrame(portName, 'subset', [], reason, { sequenceNumber: 1 }, { revision, region });
    } finally {
      this.advertising.delete(portName);
    }
  }

  private advertiseMstDatabase(reason: string, onlyPort?: string): void {
    if (!this.config.enabled || this.config.mode !== 'server' || !this.config.domain) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (onlyPort && name !== onlyPort) continue;
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.sendMstSummaryAndSubset(name, reason);
    }
  }

  private forwardOnTrunks(ingress: string, frame: EthernetFrame): void {
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (name === ingress) continue;
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      if (this.advertising.has(name)) continue;
      this.advertising.add(name);
      try {
        this.host.sendOnLink({
          iface: name,
          source: frame.srcMAC,
          destination: frame.dstMAC,
          etherType: frame.etherType,
          payload: frame.payload,
        });
      } finally { this.advertising.delete(name); }
    }
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('summary', () => {
      if (this.config.mode === 'server' && this.config.domain) {
        this.advertiseAllTrunks('periodic');
        if (this.config.version === 3) this.advertiseMstDatabase('periodic');
      }
    }, 300_000);
  }

  protected override onPortLinkUp(portName: string): void {
    if (!this.host.vtpIsTrunkPort(portName)) return;
    if (this.config.pruning) this.sendJoin(portName);
    if (!this.config.domain) return;
    if (this.config.mode === 'server') {
      this.sendSummaryAndSubset(portName, 'link-up');
      if (this.config.version === 3) this.sendMstSummaryAndSubset(portName, 'link-up');
    } else if (this.config.mode === 'client') {
      this.sendVtpFrame(portName, 'request', [], 'link-up');
    }
  }
}
