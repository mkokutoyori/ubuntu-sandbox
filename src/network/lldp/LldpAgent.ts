import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type LldpCapability, type LldpConfig, type LldpFrame, type LldpNeighborEntry,
  type LldpOptionalTlv, type LldpPortConfig,
  createDefaultLldpConfig, defaultPortConfig, neighborKey,
  LLDP_OPTIONAL_TLVS, ETHERTYPE_LLDP, LLDP_MULTICAST_MAC,
} from './types';
import { MACAddress, type DeviceType, type EthernetFrame } from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import { Logger } from '../core/Logger';
import { C2960_SOFTWARE } from '../devices/shells/cisco/CiscoPlatform';

export interface LldpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getType(): DeviceType;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendOnLink(request: LinkSendRequest): boolean;
  displayPortName?(portName: string): string;
}

export type LldpNeighbor = Readonly<LldpNeighborEntry>;

export interface LldpTraffic {
  framesOut: number;
  framesIn: number;
  entriesAged: number;
  framesInError: number;
  framesDiscarded: number;
  tlvsDiscarded: number;
  tlvsUnrecognized: number;
}

function emptyTraffic(): LldpTraffic {
  return {
    framesOut: 0, framesIn: 0, entriesAged: 0, framesInError: 0,
    framesDiscarded: 0, tlvsDiscarded: 0, tlvsUnrecognized: 0,
  };
}

export class LldpAgent extends ReactiveAgentBase {
  private config: LldpConfig = createDefaultLldpConfig();
  private readonly neighbors = new Map<string, LldpNeighborEntry>();
  private readonly advertising = new Set<string>();
  private readonly trafficByPort = new Map<string, LldpTraffic>();

  constructor(
    private readonly host: LldpHost,
    getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
  }

  getConfig(): Readonly<LldpConfig> { return this.config; }

  getTraffic(portName?: string): Readonly<LldpTraffic> {
    if (portName !== undefined) return this.portTraffic(portName);
    const total = emptyTraffic();
    for (const t of this.trafficByPort.values()) {
      for (const k of Object.keys(total) as (keyof LldpTraffic)[]) total[k] += t[k];
    }
    return total;
  }

  resetTraffic(portName?: string): void {
    if (portName === undefined) this.trafficByPort.clear();
    else this.trafficByPort.delete(portName);
  }

  private portTraffic(portName: string): LldpTraffic {
    let t = this.trafficByPort.get(portName);
    if (!t) { t = emptyTraffic(); this.trafficByPort.set(portName, t); }
    return t;
  }

  setPortTlvSelected(portName: string, tlv: LldpOptionalTlv, on: boolean): void {
    const cfg = this.getOrCreatePort(portName);
    if (on) cfg.suppressedTlvs.delete(tlv); else cfg.suppressedTlvs.add(tlv);
    if (this.config.enabled) this.advertise(portName, 'config-change');
  }

  suppressedTlvs(portName: string): ReadonlySet<LldpOptionalTlv> {
    return this.config.ports.get(portName)?.suppressedTlvs ?? new Set();
  }

  asRunningConfigLinesVrp(): string[] {
    const lines: string[] = [];
    if (this.config.enabled) lines.push('lldp enable');
    if (this.config.timerSec !== 30) {
      lines.push(`lldp message-transmission interval ${this.config.timerSec}`);
    }
    if (this.config.holdtimeMultiplier !== 4) {
      lines.push(`lldp message-transmission hold-multiplier ${this.config.holdtimeMultiplier}`);
    }
    return lines;
  }

  vrpInterfaceLines(portName: string): string[] {
    const cfg = this.config.ports.get(portName);
    if (!cfg) return [];
    return cfg.transmit || cfg.receive ? ['lldp enable'] : ['undo lldp enable'];
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.config.enabled) lines.push('lldp run');
    if (this.config.timerSec !== 30) lines.push(`lldp timer ${this.config.timerSec}`);
    if (this.config.holdtimeMultiplier !== 4) {
      lines.push(`lldp holdtime ${this.config.timerSec * this.config.holdtimeMultiplier}`);
    }
    if (this.config.reinitDelaySec !== 2) lines.push(`lldp reinit ${this.config.reinitDelaySec}`);
    return lines;
  }

  asRunningConfigForInterface(ifName: string): string[] {
    const lines: string[] = [];
    const port = this.config.ports.get(ifName);
    if (port && port.transmit === false) lines.push(' no lldp transmit');
    if (port && port.receive === false) lines.push(' no lldp receive');
    if (port) {
      for (const tlv of LLDP_OPTIONAL_TLVS) {
        if (port.suppressedTlvs.has(tlv)) lines.push(` no lldp tlv-select ${tlv}`);
      }
    }
    return lines;
  }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) {
      this.armTimers();
      this.advertiseAll('config-change');
    } else {
      this.stopTimers();
      this.flushAll('admin-disabled');
    }
    this.publishConfigChange();
  }

  setTimerSec(sec: number): void {
    if (sec < 5 || sec > 32768) return;
    this.config.timerSec = sec;
    if (this.config.enabled) {
      this.stopTimers();
      this.armTimers();
    }
    this.publishConfigChange();
  }

  setHoldtimeMultiplier(mul: number): void {
    if (mul < 2 || mul > 10) return;
    this.config.holdtimeMultiplier = mul;
    this.publishConfigChange();
  }

  setReinitDelaySec(sec: number): void {
    if (sec < 1 || sec > 10) return;
    this.config.reinitDelaySec = sec;
  }

  setPortTransmit(portName: string, on: boolean): void {
    const cfg = this.getOrCreatePort(portName);
    cfg.transmit = on;
    if (!on) this.flushPort(portName, 'admin-disabled');
    else if (this.config.enabled) this.advertise(portName, 'config-change');
  }

  setPortReceive(portName: string, on: boolean): void {
    const cfg = this.getOrCreatePort(portName);
    cfg.receive = on;
    if (!on) this.flushPort(portName, 'admin-disabled');
  }

  isPortTransmitEnabled(portName: string): boolean {
    return this.config.enabled && (this.config.ports.get(portName)?.transmit ?? true);
  }

  isPortReceiveEnabled(portName: string): boolean {
    return this.config.enabled && (this.config.ports.get(portName)?.receive ?? true);
  }

  localIdentity(portName = this.host.getPorts()[0]?.getName() ?? ''): LldpFrame {
    const port = this.host.getPort(portName);
    const label = this.host.displayPortName?.(portName) ?? portName;
    return {
      type: 'lldp',
      chassisId: port?.getMAC().toString().toLowerCase() ?? '',
      chassisIdSubtype: 'macAddress',
      portId: label,
      portIdSubtype: 'interfaceName',
      ttlSec: this.config.timerSec * this.config.holdtimeMultiplier,
      portDescription: label,
      systemName: this.host.getHostname(),
      systemDescription: this.systemDescription(),
      capabilities: [this.deviceCapability()],
      managementAddresses: this.collectAddresses(),
    };
  }

  buildAdvertisement(portName: string): LldpFrame {
    const off = this.suppressedTlvs(portName);
    const base = this.localIdentity(portName);
    return {
      ...base,
      portDescription: off.has('port-description') ? undefined : base.portDescription,
      systemName: off.has('system-name') ? undefined : base.systemName,
      systemDescription: off.has('system-description') ? undefined : base.systemDescription,
      capabilities: off.has('system-capabilities') ? undefined : base.capabilities,
      managementAddresses: off.has('management-address')
        ? undefined : base.managementAddresses,
    };
  }

  getNeighbors(): LldpNeighbor[] {
    return Array.from(this.neighbors.values());
  }

  ttlRemainingSec(n: LldpNeighbor): number {
    const reste = (n.expiresAtMs - this.getScheduler().now()) / 1000;
    return Math.max(0, Math.min(n.ttlSec, Math.ceil(reste)));
  }

  getNeighborsOnPort(portName: string): LldpNeighbor[] {
    return Array.from(this.neighbors.values()).filter(n => n.localPort === portName);
  }

  runningConfigGlobalLines(): string[] {
    const out: string[] = [];
    if (this.config.timerSec !== 30) out.push(`lldp timer ${this.config.timerSec}`);
    if (this.config.holdtimeMultiplier !== 4) {
      out.push(`lldp holdtime-multiplier ${this.config.holdtimeMultiplier}`);
    }
    if (this.config.reinitDelaySec !== 2) out.push(`lldp reinit ${this.config.reinitDelaySec}`);
    return out;
  }

  runningConfigInterfaceLines(portName: string): string[] {
    const cfg = this.config.ports.get(portName);
    if (!cfg) return [];
    const out: string[] = [];
    if (!cfg.transmit) out.push('no lldp transmit');
    if (!cfg.receive) out.push('no lldp receive');
    for (const tlv of LLDP_OPTIONAL_TLVS) {
      if (cfg.suppressedTlvs.has(tlv)) out.push(`no lldp tlv-select ${tlv}`);
    }
    return out;
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    if (!this.isPortReceiveEnabled(portName)) return;
    const payload = frame.payload as LldpFrame | undefined;
    if (!payload || payload.type !== 'lldp') return;
    const stats = this.portTraffic(portName);
    stats.framesIn += 1;
    if (!payload.chassisId || !payload.portId) {
      stats.framesInError += 1;
      stats.framesDiscarded += 1;
      return;
    }
    if (payload.ttlSec === 0) {
      this.expireByShutdownTlv(portName, payload);
      return;
    }
    const key = neighborKey(portName, payload.chassisId, payload.portId);
    const now = this.getScheduler().now();
    const expiresAtMs = now + payload.ttlSec * 1000;
    const existing = this.neighbors.get(key);
    const entry: LldpNeighborEntry = {
      localPort: portName,
      chassisId: payload.chassisId,
      chassisIdSubtype: payload.chassisIdSubtype ?? 'macAddress',
      portId: payload.portId,
      portIdSubtype: payload.portIdSubtype ?? 'interfaceName',
      systemName: payload.systemName,
      systemDescription: payload.systemDescription,
      portDescription: payload.portDescription,
      remoteType: this.capabilityToType(payload.capabilities?.[0]),
      remoteCapabilities: payload.capabilities ? [...payload.capabilities] : undefined,
      managementAddresses: payload.managementAddresses
        ? [...payload.managementAddresses] : undefined,
      learnedAtMs: now,
      ttlSec: payload.ttlSec,
      expiresAtMs,
    };
    this.neighbors.set(key, entry);
    const bus = this.getBus();
    bus.publish({
      topic: 'lldp.frame.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, remoteSystem: payload.systemName, remotePort: payload.portId,
      },
    });
    if (!existing) {
      bus.publish({
        topic: 'lldp.neighbor.discovered',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          localPort: portName, remoteSystem: payload.systemName, remotePort: payload.portId,
          remoteCapabilities: [...(payload.capabilities ?? [])], ttlSec: payload.ttlSec,
        },
      });
      Logger.info(this.host.id, 'lldp:neighbor-up',
        `${this.host.name}: LLDP neighbour ${payload.systemName} (${payload.portId}) on ${portName}`);
    } else {
      bus.publish({
        topic: 'lldp.neighbor.refreshed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          localPort: portName, remoteSystem: payload.systemName,
        },
      });
    }
    this.maybeAdvertiseBack(portName);
  }

  advertiseAll(reason: 'link-up' | 'periodic' | 'config-change'): void {
    if (!this.config.enabled) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!this.isPortTransmitEnabled(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.advertise(name, reason);
    }
  }

  advertise(portName: string, reason: 'link-up' | 'periodic' | 'config-change'): void {
    if (!this.config.enabled) return;
    if (!this.isPortTransmitEnabled(portName)) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const payload = this.buildAdvertisement(portName);
    if (this.advertising.has(portName)) return;
    this.advertising.add(portName);
    try {
      this.host.sendOnLink({
        iface: portName,
        destination: new MACAddress(LLDP_MULTICAST_MAC),
        etherType: ETHERTYPE_LLDP,
        payload,
      });
    } finally { this.advertising.delete(portName); }
    this.portTraffic(portName).framesOut += 1;
    this.getBus().publish({
      topic: 'lldp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, reason,
      },
    });
  }

  private maybeAdvertiseBack(portName: string): void {
    if (this.advertising.has(portName)) return;
    this.advertise(portName, 'link-up');
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.advertiseAll('periodic');
    this.scheduleInterval('advertise',
      () => this.advertiseAll('periodic'), this.config.timerSec * 1000);
    this.scheduleInterval('expiry', () => this.expireDue(), 1000);
  }

  protected override onPortLinkUp(portName: string): void {
    this.advertise(portName, 'link-up');
  }

  protected override onPortLinkDown(portName: string): void {
    this.flushPort(portName, 'link-down');
  }

  private expireDue(): void {
    const now = this.getScheduler().now();
    for (const [key, n] of this.neighbors) {
      if (n.expiresAtMs <= now) {
        this.neighbors.delete(key);
        this.portTraffic(n.localPort).entriesAged += 1;
        this.publishExpiry(n, 'ttl');
      }
    }
  }

  private expireByShutdownTlv(portName: string, frame: LldpFrame): void {
    const key = neighborKey(portName, frame.chassisId, frame.portId);
    const n = this.neighbors.get(key);
    if (!n) return;
    this.neighbors.delete(key);
    this.publishExpiry(n, 'admin-disabled');
  }

  private flushPort(portName: string, cause: 'link-down' | 'admin-disabled'): void {
    for (const [key, n] of this.neighbors) {
      if (n.localPort !== portName) continue;
      this.neighbors.delete(key);
      this.publishExpiry(n, cause);
    }
  }

  private flushAll(cause: 'admin-disabled'): void {
    for (const [key, n] of this.neighbors) {
      this.neighbors.delete(key);
      this.publishExpiry(n, cause);
    }
  }

  private publishExpiry(n: LldpNeighborEntry, cause: 'ttl' | 'link-down' | 'admin-disabled'): void {
    this.getBus().publish({
      topic: 'lldp.neighbor.expired',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localPort: n.localPort, remoteSystem: n.systemName, cause,
      },
    });
    Logger.info(this.host.id, 'lldp:neighbor-down',
      `${this.host.name}: LLDP neighbour ${n.systemName} on ${n.localPort} expired (${cause})`);
  }

  private publishConfigChange(): void {
    this.getBus().publish({
      topic: 'lldp.config.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        enabled: this.config.enabled,
        timerSec: this.config.timerSec,
        holdtimeMultiplier: this.config.holdtimeMultiplier,
      },
    });
  }

  private getOrCreatePort(portName: string): LldpPortConfig {
    let cfg = this.config.ports.get(portName);
    if (!cfg) {
      cfg = defaultPortConfig();
      this.config.ports.set(portName, cfg);
    }
    return cfg;
  }

  private deviceCapability(): LldpCapability {
    const t = this.host.getType();
    if (t.startsWith('router') || t.startsWith('firewall')) return 'Router';
    if (t.startsWith('switch')) return 'Bridge';
    return 'Station';
  }

  private capabilityToType(c?: LldpCapability): DeviceType {
    if (c === 'Router') return 'router-cisco';
    if (c === 'Bridge') return 'switch-cisco';
    return 'linux-pc';
  }

  private systemDescription(): string {
    const t = this.host.getType();
    switch (t) {
      case 'router-cisco':  return 'Cisco IOS Software, c2900 Software, Version 15.4(3)M';
      case 'switch-cisco':  return `Cisco IOS Software, C2960 Software, Version ${C2960_SOFTWARE.iosVersion}`;
      case 'router-huawei': return 'Huawei VRP Software, Version 5.160 (AR2200 V200R003C00)';
      case 'switch-huawei': return 'Huawei VRP Software, Version 5.170 (S5720 V200R010C00)';
      case 'firewall-fortinet': return 'FortiGate';
      default: return t;
    }
  }

  private collectAddresses(): string[] {
    const out: string[] = [];
    for (const p of this.host.getPorts()) {
      const ip = p.getIPAddress();
      if (ip) out.push(ip.toString());
    }
    return out;
  }
}
