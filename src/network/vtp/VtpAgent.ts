import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type VtpConfig, type VtpFrame, type VtpMode, type VtpVersion, type VtpVlanEntry,
  createDefaultVtpConfig, hashPassword,
  ETHERTYPE_VTP, VTP_MULTICAST_MAC,
} from './types';
import { MACAddress, type EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';

export interface VtpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  vtpListVlans(): VtpVlanEntry[];
  vtpApplyVlans(vlans: VtpVlanEntry[]): { added: number[]; removed: number[] };
  vtpIsTrunkPort(portName: string): boolean;
}

export class VtpAgent extends ReactiveAgentBase {
  private config: VtpConfig;
  private readonly advertising = new Set<string>();

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
  }

  setDomain(name: string): void {
    if (this.config.domain === name) return;
    const old = this.config.domain;
    this.config.domain = name;
    this.config.revision = 0;
    this.getBus().publish({
      topic: 'vtp.domain.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        oldDomain: old, newDomain: name, version: this.config.version,
      },
    });
    if (this.config.mode === 'server') this.advertiseSummary('config-change');
  }

  setPassword(pw: string): void {
    this.config.password = pw;
  }

  setVersion(v: VtpVersion): void {
    this.config.version = v;
  }

  setPruning(on: boolean): void {
    this.config.pruning = on;
  }

  bumpRevision(): void {
    if (this.config.mode !== 'server' || !this.config.domain) return;
    this.config.revision += 1;
    this.advertiseSummary('local-vlan-change');
  }

  onLocalVlanChange(): void {
    this.bumpRevision();
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
    } else if (this.config.domain && payload.passwordHash !== hashPassword(this.config.domain, this.config.password)) {
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

    if (this.config.mode === 'server' || this.config.mode === 'client') {
      if (payload.revision > this.config.revision) {
        const oldRev = this.config.revision;
        const result = this.host.vtpApplyVlans(payload.vlans);
        this.config.revision = payload.revision;
        this.config.updaterMac = payload.updater;
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
  }

  advertiseAllTrunks(reason: 'periodic' | 'config-change' | 'local-vlan-change' | 'relay'): void {
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

  private sendSummaryAndSubset(portName: string, reason: string): void {
    if (this.advertising.has(portName)) return;
    const port = this.host.getPort(portName);
    if (!port) return;
    const vlans = this.host.vtpListVlans();
    const payload: VtpFrame = {
      type: 'vtp', version: this.config.version,
      messageType: 'summary',
      domain: this.config.domain,
      revision: this.config.revision,
      updater: this.config.updaterMac,
      passwordHash: hashPassword(this.config.domain, this.config.password),
      vlans,
    };
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload,
    };
    this.advertising.add(portName);
    try { this.host.sendFrame(portName, eth); }
    finally { this.advertising.delete(portName); }
    this.getBus().publish({
      topic: 'vtp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        messageType: `summary:${reason}`,
        domain: this.config.domain,
        revision: this.config.revision,
      },
    });
  }

  private forwardOnTrunks(ingress: string, frame: EthernetFrame): void {
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (name === ingress) continue;
      if (!this.host.vtpIsTrunkPort(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      if (this.advertising.has(name)) continue;
      this.advertising.add(name);
      try { this.host.sendFrame(name, frame); }
      finally { this.advertising.delete(name); }
    }
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('summary', () => {
      if (this.config.mode === 'server' && this.config.domain) {
        this.advertiseAllTrunks('periodic');
      }
    }, 300_000);
  }

  protected override onPortLinkUp(portName: string): void {
    if (this.config.mode === 'server' && this.config.domain
        && this.host.vtpIsTrunkPort(portName)) {
      this.sendSummaryAndSubset(portName, 'link-up');
    }
  }
}
