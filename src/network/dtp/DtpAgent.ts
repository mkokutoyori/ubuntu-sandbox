import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type DtpAdminMode, type DtpConfig, type DtpFrame, type DtpOperationalMode,
  type DtpPortState,
  createDefaultDtpConfig, defaultPortState, resolveOperationalMode, shouldEmitDtp,
  ETHERTYPE_DTP, DTP_MULTICAST_MAC,
} from './types';
import { MACAddress, type EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';

export interface DtpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  onOperationalModeChanged(portName: string, mode: DtpOperationalMode): void;
}

export class DtpAgent extends ReactiveAgentBase {
  private config: DtpConfig = createDefaultDtpConfig();
  private readonly advertising = new Set<string>();

  constructor(
    private readonly host: DtpHost,
    getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
  }

  getConfig(): Readonly<DtpConfig> { return this.config; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) {
      this.armTimers();
      this.advertiseAll();
    } else {
      this.stopTimers();
    }
  }

  setHelloSec(sec: number): void {
    if (sec < 5 || sec > 300) return;
    this.config.helloSec = sec;
    if (this.config.enabled) {
      this.stopTimers();
      this.armTimers();
    }
  }

  setDomain(name: string): void {
    this.config.domain = name.slice(0, 32);
  }

  getPortState(portName: string): DtpPortState {
    let s = this.config.ports.get(portName);
    if (!s) {
      s = defaultPortState();
      this.config.ports.set(portName, s);
    }
    return s;
  }

  setAdminMode(portName: string, adminMode: DtpAdminMode): void {
    const s = this.getPortState(portName);
    if (s.adminMode === adminMode) return;
    const oldOp = s.operationalMode;
    s.adminMode = adminMode;
    if (adminMode === 'nonegotiate') s.peerAdminMode = null;
    const newOp = resolveOperationalMode(s.adminMode, s.peerAdminMode);
    if (newOp !== oldOp) {
      s.operationalMode = newOp;
      this.host.onOperationalModeChanged(portName, newOp);
      this.publishModeChange(portName, s.adminMode, oldOp, newOp, 'admin-change');
    } else {
      s.operationalMode = newOp;
    }
    if (this.config.enabled && shouldEmitDtp(adminMode) && adminMode !== 'nonegotiate') {
      this.advertise(portName);
    }
  }

  getAdminMode(portName: string): DtpAdminMode {
    return this.getPortState(portName).adminMode;
  }

  getOperationalMode(portName: string): DtpOperationalMode {
    return this.getPortState(portName).operationalMode;
  }

  runningConfigInterfaceLines(portName: string): string[] {
    const s = this.config.ports.get(portName);
    if (!s) return [];
    const out: string[] = [];
    if (s.adminMode === 'dynamic-auto') out.push('switchport mode dynamic auto');
    else if (s.adminMode === 'dynamic-desirable') out.push('switchport mode dynamic desirable');
    if (s.adminMode === 'nonegotiate' || s.adminMode === 'trunk') {
      const explicit = this.config.ports.get(portName);
      if (explicit && s.adminMode === 'nonegotiate') out.push('switchport nonegotiate');
    }
    return out;
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    const s = this.getPortState(portName);
    if (s.adminMode === 'nonegotiate') return;
    const payload = frame.payload as DtpFrame | undefined;
    if (!payload || payload.type !== 'dtp') return;
    if (this.config.domain && payload.domain && payload.domain !== this.config.domain) return;
    const oldOp = s.operationalMode;
    s.peerAdminMode = payload.adminMode;
    s.peerMac = payload.neighborMac;
    s.lastHelloMs = Date.now();
    const newOp = resolveOperationalMode(s.adminMode, s.peerAdminMode);
    s.operationalMode = newOp;
    this.getBus().publish({
      topic: 'dtp.frame.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, peerMac: payload.neighborMac, peerAdminMode: payload.adminMode,
      },
    });
    if (newOp !== oldOp) {
      this.host.onOperationalModeChanged(portName, newOp);
      this.publishModeChange(portName, s.adminMode, oldOp, newOp, 'peer-update');
    }
    this.maybeAdvertiseBack(portName);
  }

  advertiseAll(): void {
    if (!this.config.enabled) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      const s = this.getPortState(name);
      if (!shouldEmitDtp(s.adminMode)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.advertise(name);
    }
  }

  advertise(portName: string): void {
    if (!this.config.enabled) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const s = this.getPortState(portName);
    if (!shouldEmitDtp(s.adminMode) || s.adminMode === 'nonegotiate') return;
    const payload: DtpFrame = {
      type: 'dtp',
      domain: this.config.domain,
      adminMode: s.adminMode,
      operationalMode: s.operationalMode,
      trunkEncapsulation: s.trunkEncapsulation,
      neighborMac: port.getMAC().toString().toLowerCase(),
    };
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(DTP_MULTICAST_MAC),
      etherType: ETHERTYPE_DTP,
      payload,
    };
    if (this.advertising.has(portName)) return;
    this.advertising.add(portName);
    try { this.host.sendFrame(portName, frame); }
    finally { this.advertising.delete(portName); }
    this.getBus().publish({
      topic: 'dtp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, adminMode: s.adminMode, operationalMode: s.operationalMode,
      },
    });
  }

  private maybeAdvertiseBack(portName: string): void {
    if (this.advertising.has(portName)) return;
    this.advertise(portName);
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('hello', () => this.advertiseAll(),
      this.config.helloSec * 1000);
  }

  protected override onPortLinkUp(portName: string): void {
    this.advertise(portName);
  }

  protected override onPortLinkDown(portName: string): void {
    this.handleLinkDown(portName);
  }

  private handleLinkDown(portName: string): void {
    const s = this.config.ports.get(portName);
    if (!s) return;
    const oldOp = s.operationalMode;
    s.peerAdminMode = null;
    s.peerMac = null;
    const newOp = resolveOperationalMode(s.adminMode, null);
    s.operationalMode = newOp;
    if (newOp !== oldOp) {
      this.host.onOperationalModeChanged(portName, newOp);
      this.publishModeChange(portName, s.adminMode, oldOp, newOp, 'link-down');
    }
  }

  private publishModeChange(
    portName: string,
    adminMode: DtpAdminMode,
    oldOp: DtpOperationalMode,
    newOp: DtpOperationalMode,
    reason: 'admin-change' | 'peer-update' | 'peer-loss' | 'link-down',
  ): void {
    this.getBus().publish({
      topic: 'dtp.mode.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, adminMode,
        oldOperationalMode: oldOp, newOperationalMode: newOp, reason,
      },
    });
    Logger.info(this.host.id, 'dtp:mode-change',
      `${this.host.name}: ${portName} ${oldOp} → ${newOp} (${reason})`);
  }
}
